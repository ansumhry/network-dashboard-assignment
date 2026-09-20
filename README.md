# Protocol Visualizer

I made this for my Computer Networks assignment for Application Layer.

It has two sides - on the left you can see what user is doing like browsing, sending mail, watching video. 
On the right side it shows what is happening behind like DNS, HTTP, SMTP messages step by step.

I made it using only HTML, CSS and JavaScript. No backend, no real network, everything is just simulated messages.

*Live link:* [paste your GitHub Pages link here] 
*AI used:* Claude Sonnet 4.5 - I used it to help me structure the code and for CSS.

### How to run---

Just download the folder and open `index.html` in browser. Or if you use VS Code, right click and Open with Live Server, that works better.

### How to put it online---

I put it on GitHub Pages.
1. Made a new public repo
2. Uploaded all files - index.html, style.css, app.js, simulators.js and README
3. Went to Settings -> Pages -> Deploy from branch -> selected main and root
4. Waited 1-2 mins and got the link like `https://username.github.io/repo-name/`

### Files in this project---

- `index.html` - main page, buttons and layout
- `style.css` - for design and colors
- `simulators.js` - this file creates the fake DNS/HTTP/SMTP messages
- `app.js` - controls Next, Back, Play, slider etc
- `README.md` - this file

### How I synced both panels---

My simulator gives a list of events. I keep a variable `index`. 
Right panel shows messages till that index. Left panel shows UI for that same index. So when I click Next/Back or move slider, both panels change together because they use same index.

### What you can do in it---

*Browsing mode:* First it does DNS query/response then HTTP request/response. You can also turn on TCP/TLS handshake, request for extra files like css/js, and check difference between persistent and non-persistent.

*Mail mode:* First DNS for MX record, then full SMTP - like greeting, EHLO, MAIL FROM, RCPT TO, DATA, then actual mail and QUIT.

*Streaming mode:* DNS then HTTP for playlist and video chunks. If you press pause it stops requesting, if you change quality it fetches new playlist.

### Some simplifications I made---

- No real network, all fake data
- DNS I showed as text only, not as binary packet
- HTTPS I showed as decrypted for easy understanding
- For mail I used port 25

### You can try these---

- In browsing type `nope.invalid` - you will get DNS fail, or `example.com/missing` for 404 error
- Try persistent vs non-persistent and see how many connections it makes
- In mail body if you type a line starting with "." see what happens (SMTP dot stuffing)
- On right side tick "Show line endings" to see CRLF
