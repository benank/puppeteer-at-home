# 🏠 Puppeteer at Home

Puppeteer at home allows you to run a headless [puppeteer](https://pptr.dev/) instance on a Raspberry Pi (or similar) at home, and then connect to it from anywhere. It uses [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to connect to your Raspberry Pi from anywhere using a custom domain name.

Running puppeteer at home allows you to have complete control over the service, as well as use custom plugins, such as [puppeteer-extra](https://www.npmjs.com/package/puppeteer-extra).

## Installation

> [!NOTE]
> This guide was originally written for the Raspberry Pi 4, but it should be mostly compatible with any mini computer. If you're not using Linux, you'll need to modify more code to make it work.

1. Install Raspberry Pi OS on your Raspberry Pi.
2. Connect to your Raspberry Pi and run the following commands:
```bash
sudo apt update && sudo apt upgrade
sudo apt install chromium-browser
```
3. Install [nvm](https://github.com/nvm-sh/nvm). After installing, run this command: `nvm install v22` to install NodeJS 22.
3. Follow [this guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/) to create a Cloudflare Tunnel. For environment, choose `Debian -> arm64-bit`, and then copy and run the commands from the **Install and run a connector** section, which should look something like the ones below:
```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb && 
sudo dpkg -i cloudflared.deb && 
sudo cloudflared service install YOUR_TOKEN_HERE
```
4. After installing and configuring `cloudflared` with the above commands, you should see it reporting as healthy on the Cloudflare dashboard.
5. Now add two public hostnames to your tunnel on the dashboard:
 - Hostname 1:
    - Subdomain: anything, such as `puppeteer`
    - Domain: one of your domains
    - Service type: HTTP
    - URL: `localhost:3000`

 - Hostname 2:
    - Subdomain: anything (different than the above), like `puppeteer-ws`
    - Domain: one of your domains
    - Service type: HTTP
    - URL: `localhost:3001`

6. Create a `.env` file with the following contents (fill out `AUTH_TOKEN` and `PUBLIC_DOMAIN` with your own):
```
AUTH_TOKEN="RANDOM_TOKEN"
PORT=3000
WS_PROXY_PORT=3001
PUBLIC_DOMAIN="HOSTNAME_2_DOMAIN"
# eg. puppeteer-ws.example.com
```
7. Run `npm install`
8. Run `npm run start` to start puppeteer at home.


### Install as a service

To ensure that puppeteer at home is always running, even after restarts, add it as a service with these steps:


1. Modify `puppeteer.service` with your own information depending on where you installed puppeteer at home on your system.
2. Copy the service: `sudo cp puppeteer.service /etc/systemd/system/puppeteer.service`
3. Reload services: `sudo systemctl daemon-reload`
4. Enable the service: `sudo systemctl enable puppeteer`
5. Start the service: `sudo systemctl start puppeteer`
6. Check service status to make sure it's running: `sudo systemctl status puppeteer`


## Usage

Once you've completed the setup above and puppeteer at home is running, this is how you can use it:

### Get Status

To ensure that your service is up and running, use a GET request to your domain to check:
```
curl -X GET "https://puppeteer.yourdomain.com/status" \
  -H "Authorization: Bearer AUTH_TOKEN"
```

If it's running, this will return a 200 response with the following data:
```ts
{
    status: 'running',
    browser: 'connected' | 'disconnected',
    activeTabs: number
}
```

If it's not running, you'll likely get a 502 Bad Gateway error from Cloudflare.

### Launch Browser

To launch/get access to a headless puppeteer browser, use a GET request:

```
curl -X GET "https://puppeteer.yourdomain.com/browser" \
  -H "Authorization: Bearer AUTH_TOKEN"
```

This will return a 200 response with these fields:
```ts
{
    wsEndpoint: "wss://puppeteer-ws.yourdomain.com/41683/devtools/browser/3a95e2df-6cf8-4365-a336-615f3db1054a",
    version: "Chrome/130.0.6723.116",
}
```

In your application code, use `wsEndpoint` to connect to the puppeteer browser devtools:
```ts
import * as puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({
    browserWSEndpoint,
})

// After connecting, use it like a normal puppeteer instance - open pages, get text and data, capture screenshots, etc

const page = await browser.newPage();
await page.goto('https://github.com/benank/puppeteer-at-home');

const title = await page.title();
console.log(`Page title: ${title}`);

// Close and cleanup
await page.close();
```

Keep in mind that closing inactive tabs is not strictly necessary - puppeteer at home will close inactive tabs after 5 minutes of no network activity. However, if the browser is closed, it may interrupt other ongoing connections.


## FAQ

### Why?

There are a lot of solutions already out there to do browser rendering, such as [Cloudflare Browser Rendering](velopers.cloudflare.com/browser-rendering/) or [Browserless](https://www.browserless.io/). But running at home can often be cheaper, more stable (surprisingly), gives you more control, and be more fun! 

### Why is there a websocket proxy?

The websocket ports opened for devtool connections with puppeteer are dynamic and different every time, so the system needed a way to map a static port that Cloudflare Tunnel could use to the dynamic ports of puppeteer - hence, a websocket proxy to route requests.

### Is this secure?

Your Raspberry Pi's IP (and your IP) are secure behind Cloudflare Tunnel. However, connecting to the websocket means that you'll be able to interact with the browser and potentially get more sensitive data about the device, such as its IP, so be careful about access. Access to the websockets is secured with a random token that you generate. All of these systems should usually only interface with other backend systems, so clients shouldn't usually have visibility into any of this.