import http from 'http';
import url from 'url';
import * as puppeteer from 'puppeteer';
import { config } from 'dotenv';
import { exec } from 'child_process';
import { promisify } from 'util';
import { WebSocketServer, WebSocket as WS } from 'ws';

config();

// --- Configuration ---
const PORT: number = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN; // Your Cloudflare Tunnel domain (if needed)
const INACTIVE_TAB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const WS_PROXY_PORT = process.env.WS_PROXY_PORT ? parseInt(process.env.WS_PROXY_PORT, 10) : 3001; // Public WebSocket proxy port

// --- Global Variables ---
let browser: puppeteer.Browser | null = null;
const tabLastActivity: Map<string, number> = new Map();
const execAsync = promisify(exec);

// --- Utility Functions ---

/**
 * Kill any existing Chrome processes.
 */
async function killExistingBrowsers(): Promise<void> {
  try {
    const cmd = process.platform === 'win32'
      ? 'taskkill /F /IM chrome.exe /T'
      : 'pkill -f chrome';
    await execAsync(cmd);
    console.log('Cleaned up existing Chrome processes');
  } catch (error) {
    console.log('No existing Chrome processes found');
  }
}

/**
 * Launch (or reuse) a Puppeteer browser instance.
 */
async function launchBrowser(): Promise<puppeteer.Browser> {
  if (browser) {
    try {
      await browser.pages();
      return browser;
    } catch (error) {
      console.log('Browser appears disconnected; launching a new one...');
    }
  }

  browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium-browser',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  });

  // Listen for browser disconnection
  browser.on('disconnected', () => {
    console.log('Browser disconnected; it will relaunch on next request.');
    browser = null;
    tabLastActivity.clear();
  });

  // Track tab activity by listening to target events
  browser.on('targetcreated', async (target) => {
    try {
      const type = target.type();
      const session = await target.createCDPSession();
      const targetId = session.id();

      if (type === 'page') {
        tabLastActivity.set(targetId, Date.now());
        console.log(`New tab created: ${targetId}`);

        try {
          const page = await target.page();
          if (page) {
            page.on('request', () => {
              tabLastActivity.set(targetId, Date.now());
            });
          }
        } catch (error) {
          console.error('Error attaching to page:', error);
        }
      }
    } catch (error) {
      console.error('Error handling target creation:', error);
    }
  });

  browser.on('targetdestroyed', async (target) => {
    try {
      const type = target.type();
      const session = await target.createCDPSession();
      const targetId = session.id();
      if (type === 'page') {
        tabLastActivity.delete(targetId);
        console.log(`Tab closed: ${targetId}`);
      }
    } catch (error) {
      console.error('Error handling target destruction:', error);
    }
  });

  return browser;
}

/**
 * Remap a local WebSocket endpoint (returned by Puppeteer) to one that uses your public domain and proxy port.
 * Example: ws://127.0.0.1:43507/devtools/browser/xxx becomes wss://PUBLIC_DOMAIN/43507/devtools/browser/xxx
 */
function remapWebSocketEndpoint(wsEndpoint: string): string {
  console.log(`Remapping WebSocket endpoint from ${wsEndpoint}`);
  const wsUrl = new URL(wsEndpoint);
  const browserWsPort = wsUrl.port;
  return `wss://${PUBLIC_DOMAIN}/${browserWsPort}${wsUrl.pathname}`;
}

// --- WebSocket Proxy Server ---
// All incoming WebSocket connections are accepted on WS_PROXY_PORT.
// The URL must be in the format: "/<originalPort>/<path>" so that we know which local port to connect to.
const wsServer = new WebSocketServer({ port: WS_PROXY_PORT });
console.log(`WebSocket proxy server started on port ${WS_PROXY_PORT}`);

wsServer.on('connection', (clientWs, request) => {
  const path = request.url || '';
  console.log(`New client connected with URL: ${path}`);

  // Expect URL format: "/<port>/<rest-of-path>"
  const match = path.match(/^\/(\d+)(\/.*)/);
  if (!match) {
    clientWs.close(1002, 'Invalid WebSocket URL format');
    console.log('Client disconnected: invalid URL format');
    return;
  }
  const [, originalPort, originalPath] = match;
  const targetUrl = `ws://127.0.0.1:${originalPort}${originalPath}`;
  console.log(`Multiplexing to internal WebSocket: ${targetUrl}`);

  const chromeWs = new WS(targetUrl, {
    perMessageDeflate: false,
    handshakeTimeout: 5000,
    maxPayload: 50 * 1024 * 1024
  });

  // Set up message forwarding BEFORE the open event to catch initial messages
  // Forward messages from client to Chrome as soon as possible
  clientWs.on('message', (data, isBinary) => {
    try {
      if (chromeWs.readyState === WS.OPEN) {
        chromeWs.send(data, { binary: isBinary });
      } else {
        console.log(`Warning: Chrome WebSocket not ready (state: ${chromeWs.readyState}), message queued`);
        // Queue messages that come in before connection is ready
        chromeWs.once('open', () => {
          chromeWs.send(data, { binary: isBinary });
          console.log('Sent queued message after connection opened');
        });
      }
    } catch (err) {
      console.error('Error forwarding client message:', err);
    }
  });

  // Forward messages from Chrome to client
  chromeWs.on('message', (data, isBinary) => {
    try {
      if (clientWs.readyState === WS.OPEN) {
        clientWs.send(data, { binary: isBinary });
      } else {
        console.log(`Warning: Client WebSocket not ready (state: ${clientWs.readyState}), message dropped`);
      }
    } catch (err) {
      console.error('Error forwarding chrome message:', err);
    }
  });

  // Track connection state for debugging
  let connectionActive = false;

  chromeWs.on('open', () => {
    connectionActive = true;
    console.log(`Proxy connection established to ${targetUrl}`);
    
    // Send a ping to verify the connection is working
    if (chromeWs.ping) {
      chromeWs.ping(() => {
        console.log('Chrome WebSocket responded to ping');
      });
    }
  });

  // Improved error handling
  const cleanup = (reason: string) => {
    if (connectionActive) {
      console.log(`Cleaning up WebSocket connections: ${reason}`);
      connectionActive = false;
    }
    
    if (clientWs.readyState === WS.OPEN) {
      clientWs.close();
    }
    
    if (chromeWs.readyState === WS.OPEN) {
      chromeWs.close();
    }
  };

  clientWs.on('close', (code, reason) => {
    cleanup(`Client WebSocket closed (${code}: ${reason || 'No reason provided'})`);
  });
  
  chromeWs.on('close', (code, reason) => {
    cleanup(`Chrome WebSocket closed (${code}: ${reason || 'No reason provided'})`);
  });
  
  clientWs.on('error', (err) => {
    console.error('Client WebSocket error:', err);
    cleanup(`Client error: ${err.message}`);
  });
  
  chromeWs.on('error', (err) => {
    console.error('Chrome WebSocket error:', err);
    cleanup(`Chrome error: ${err.message}`);
  });
  
  // Additional events for debugging
  chromeWs.on('unexpected-response', (request, response) => {
    console.error(`Unexpected response from Chrome: ${response.statusCode}`);
    cleanup(`Unexpected response: ${response.statusCode}`);
  });
  
  chromeWs.on('upgrade', (response) => {
    console.log(`Chrome WebSocket upgraded: ${response.statusCode}`);
  });
  
  clientWs.on('ping', (data) => {
    console.log(`Received ping from client: ${data.toString()}`);
  });
  
  chromeWs.on('ping', (data) => {
    console.log(`Received ping from Chrome: ${data.toString()}`);
  });
});

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request' }));
    return;
  }

  const parsedUrl = url.parse(req.url, true);

  // Basic authentication check
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  if (parsedUrl.pathname === '/status') {
    const activeTabsCount = tabLastActivity.size;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      browser: browser ? 'connected' : 'disconnected',
      activeTabs: activeTabsCount,
    }));
  } else if (parsedUrl.pathname === '/browser') {
    try {
      const browserInstance = await launchBrowser();
      const localWsEndpoint = browserInstance.wsEndpoint();
      const publicWsEndpoint = remapWebSocketEndpoint(localWsEndpoint);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        wsEndpoint: publicWsEndpoint,
        version: await browserInstance.version(),
      }));
    } catch (error) {
      console.error('Error launching browser:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to launch browser' }));
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

// --- Server Initialization & Cleanup ---
async function initialize() {
  await killExistingBrowsers();
  server.listen(PORT, () => {
    console.log(`Puppeteer service running on port ${PORT}`);
  });
}

initialize().catch((error) => {
  console.error('Failed to initialize server:', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down...');
  wsServer.close();
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down...');
  wsServer.close();
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

/**
 * Periodically cleans up inactive tabs.
 */
async function cleanupInactiveTabs(): Promise<void> {
  if (!browser) return;
  const now = Date.now();
  const pages = await browser.pages();
  for (const page of pages) {
    try {
      const target = page.target();
      const session = await target.createCDPSession();
      const targetId = session.id();
      const lastActivity = tabLastActivity.get(targetId);
      const pageUrl = page.url();
      if (pageUrl === 'about:blank' && pages.length <= 1) {
        continue;
      }
      if (lastActivity && (now - lastActivity > INACTIVE_TAB_TIMEOUT_MS)) {
        console.log(`Closing inactive tab ${targetId} (${pageUrl}), inactive for ${Math.round((now - lastActivity) / 1000)} seconds`);
        await page.close();
        tabLastActivity.delete(targetId);
      }
      await session.detach();
    } catch (error) {
      console.error('Error when trying to close inactive tab:', error);
    }
  }
}

const cleanupInterval = setInterval(cleanupInactiveTabs, 60 * 1000);
process.on('exit', () => {
  clearInterval(cleanupInterval);
});
