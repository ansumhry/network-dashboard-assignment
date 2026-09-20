# Protocol Visualizer

A dual-panel dashboard for Computer Networks (Application Layer).
The left panel is an activity (Browsing, Mail, Streaming). The right panel shows the DNS, HTTP and SMTP messages behind it, one step at a time.

Pure HTML, CSS and JavaScript. No build step and no server code. The protocols are simulated.

**Live link:** _paste your GitHub Pages link here_

**AI platform and model used:** _write it here (for example: Claude, Sonnet 5)_

## Run it locally

Open the folder in VS Code, right-click `index.html`, and choose **Open with Live Server**.
You can also just double-click `index.html`.

## Put it online with GitHub Pages

1. Create a new public repository on GitHub.
2. Upload these files to the top level of the repository: `index.html`, `style.css`, `app.js`, `simulators.js`, `README.md`.
3. In the repository go to **Settings, Pages**. Under "Build and deployment" choose **Deploy from a branch**, pick the `main` branch and the `/ (root)` folder, then save.
4. After a minute the live link appears at the top of that page. It looks like `https://YOUR-NAME.github.io/REPOSITORY-NAME/`.

## Files

| File | Job |
|---|---|
| `index.html` | The two panels, tabs, forms and player controls |
| `style.css` | Layout, sequence diagram, colors, small-screen layout |
| `simulators.js` | Builds the list of protocol messages for each activity |
| `app.js` | The player and the synchronization between the panels |

## How the panels stay in sync

The simulator returns a list of events. Each mode stores `{ events, index }`.
The right panel draws `events[0..index]`. The left panel (status line, activity log, page or mail or video preview) is drawn from `events[index].ui`.
Both panels read the same `index`, so Next, Back, Play, the slider, clicking a step and Replay always move them together.

## What each activity shows

- **Browsing:** DNS query and response (A record), then HTTP GET and response. Optional TCP handshake and TLS handshake, optional extra files, and a persistent or non-persistent connection choice.
- **Mail:** DNS query for the MX record, then SMTP: 220 greeting, EHLO, 250 (multi-line), MAIL FROM, 250, RCPT TO, 250, DATA, 354, message ending with a lone ".", 250 queued, QUIT, 221.
- **Streaming:** DNS, then HTTP GET for the master playlist, the quality playlist, and video segments. Pausing stops segment requests. Changing quality fetches the new playlist, and later segments come from the new quality.

## Simplifications (say these in your reflection)

- Nothing goes over a real network. DNS answers use documentation-only IP ranges, except `example.com`.
- DNS is shown in dig-style text. Real DNS messages are binary.
- HTTPS traffic is shown decrypted so it can be read.
- The requests send `Accept-Encoding: identity` so bodies stay readable.
- SMTP uses port 25 (server to server). Mail apps normally submit on port 587 with a login and STARTTLS.

## Things to try

- Browsing: type `nope.invalid` (DNS returns NXDOMAIN) or `example.com/missing` (HTTP returns 404).
- Browsing: open Connection options, tick both boxes, and compare Persistent with Non-persistent.
- Mail: put a line starting with "." in the body and watch the client add a second ".".
- Right panel: tick "Show line endings" to see the CR+LF at the end of each line.
