/* ==========================================================================
   simulators.js
   Builds lists ("traces") of protocol events. It never touches the page.
   app.js plays these lists back on the right panel.

   Every event looks like this:
   {
     protocol : 'DNS' | 'TCP' | 'TLS' | 'HTTP' | 'SMTP' | 'PLAYER',
     dir      : 'c2s' (client -> other side) | 's2c' (other side -> client) | 'local',
     peer     : 'resolver' | 'server' | 'client',   // who the client is talking to
     label    : short text drawn on the arrow,
     transport: "UDP 192.168.1.23:52114 -> 192.168.1.1:53" style line,
     raw      : the exact message text shown in the detail box,
     highlight: [substrings to highlight inside raw],
     note     : one or two sentences explaining what is happening,
     fields   : [[name, meaning], ...] key fields explained,
     ui       : what the LEFT panel should show while this step is current,
     t_ms     : simulated time since the activity started
   }
   ========================================================================== */
(function (global) {
  'use strict';

  var CLIENT_IP = '192.168.1.23';
  var RESOLVER_IP = '192.168.1.1';
  var CLIENT_HOST = 'student-pc.local';
  var DEFAULT_SENDER = 'student@cn-lab.local';
  var STREAM_HOST = 'stream.example.com';
  var CRLF = '\r\n';
  var UA = 'Mozilla/5.0 (CN-Lab Visualizer)';
  var EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

  var enc = new TextEncoder();
  function byteLen(s) { return enc.encode(s).length; }
  function fmtNum(n) { return n.toLocaleString('en-US'); }
  function hex(n, w) { return n.toString(16).padStart(w, '0'); }

  /* ---------- small deterministic random numbers (same input -> same trace) ---------- */
  function hash(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }
  // Documentation-only address ranges, so we never claim a real server's address.
  function fakeIp(host) {
    if (host === 'example.com') return '93.184.216.34';
    var h = hash(host);
    var nets = ['192.0.2', '198.51.100', '203.0.113'];
    return nets[h % 3] + '.' + (((h >>> 4) % 250) + 2);
  }

  /* ---------- Trace: an ordered list of events plus a simulated clock ---------- */
  function Trace(seed, t0) {
    this.rand = makeRng(seed);
    this.t = t0 || 0;
    this.events = [];
  }
  Trace.prototype.wait = function (min, max) {
    this.t += Math.round(min + this.rand() * (max - min));
    return this;
  };
  Trace.prototype.int = function (min, max) {
    return Math.floor(min + this.rand() * (max - min + 1));
  };
  Trace.prototype.push = function (e) {
    e.t_ms = this.t;
    this.events.push(e);
    return e;
  };

  /* ---------- HTTP text builders (CRLF line endings, blank line before body) ---------- */
  function httpRequest(o) {
    var defPort = o.scheme === 'https' ? 443 : 80;
    var hostHdr = o.port === defPort ? o.host : o.host + ':' + o.port;
    var lines = [
      (o.method || 'GET') + ' ' + o.path + ' HTTP/1.1',
      'Host: ' + hostHdr,
      'User-Agent: ' + UA,
      'Accept: ' + o.accept,
      'Accept-Language: en-US,en;q=0.9',
      'Accept-Encoding: identity'
    ];
    (o.extra || []).forEach(function (kv) { lines.push(kv[0] + ': ' + kv[1]); });
    lines.push('Connection: ' + o.conn);
    return { raw: lines.join(CRLF) + CRLF + CRLF, hostHdr: hostHdr };
  }
  function httpResponse(o) {
    var lines = ['HTTP/1.1 ' + o.status + ' ' + o.reason, 'Date: ' + o.date.toUTCString(), 'Server: nginx'];
    o.headers.forEach(function (kv) { lines.push(kv[0] + ': ' + kv[1]); });
    return lines.join(CRLF) + CRLF + CRLF + o.body;
  }

  /* ---------- DNS (shown in dig-style text; real DNS is binary over UDP port 53) ---------- */
  function rr(name, ttl, type, data) {
    return name.padEnd(26) + String(ttl).padEnd(8) + 'IN  ' + type.padEnd(4) + data;
  }

  // cb.query() and cb.answer(result) return the left-panel "ui" objects.
  function dnsExchange(tr, name, type, cb) {
    var fqdn = name + '.';
    var id = '0x' + hex(tr.int(0, 65535), 4);
    var port = tr.int(49152, 65000);
    var nx = /\.invalid$/i.test(name);
    var target = type === 'MX' ? 'mail.' + name : name;
    var ip = fakeIp(target);
    var ttl = type === 'MX' ? 3600 : [60, 300, 300, 3600][tr.int(0, 3)];
    var inLabel = 'IN  ' + type;
    var question = ';' + fqdn.padEnd(26) + inLabel;

    var qRaw = [
      ';; opcode: QUERY, id: ' + id,
      ';; flags: rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 0',
      '',
      ';; QUESTION SECTION:',
      question
    ].join('\n');

    tr.push({
      protocol: 'DNS', dir: 'c2s', peer: 'resolver',
      label: 'DNS query: ' + type + ' ' + name,
      transport: 'UDP ' + CLIENT_IP + ':' + port + ' \u2192 ' + RESOLVER_IP + ':53',
      raw: qRaw,
      highlight: [id, fqdn, inLabel],
      note: type === 'MX'
        ? 'Before sending mail, the client must find which server accepts mail for the domain. An MX record names that mail server; it is not the address of the website.'
        : 'The client asks its DNS resolver to turn the name into an IP address. DNS normally uses UDP port 53.',
      fields: [
        ['Transaction ID', 'A random number copied into the reply so the client can match answer to question.'],
        ['Question type', type === 'MX' ? 'MX = mail exchanger for the domain.' : 'A = the IPv4 address for this name.'],
        ['Flag rd', 'Recursion desired: "please do the full lookup for me."']
      ],
      ui: cb.query()
    });

    tr.wait(12, 45);

    var status = nx ? 'NXDOMAIN' : 'NOERROR';
    var counts = nx ? 'ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 0'
      : type === 'MX' ? 'ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1'
      : 'ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 0';
    var lines = [
      ';; opcode: QUERY, status: ' + status + ', id: ' + id,
      ';; flags: qr rd ra; QUERY: 1, ' + counts,
      '',
      ';; QUESTION SECTION:',
      question,
      ''
    ];
    var hl = [id, fqdn, inLabel];
    var label;
    if (nx) {
      lines.push(';; AUTHORITY SECTION:');
      lines.push(rr('.', 86400, 'SOA', 'a.root-servers.net. nstld.verisign-grs.com. 2026092001 1800 900 604800 86400'));
      hl.push('status: NXDOMAIN');
      label = 'DNS response: NXDOMAIN';
    } else if (type === 'MX') {
      lines.push(';; ANSWER SECTION:');
      lines.push(rr(fqdn, ttl, 'MX', '10 ' + target + '.'));
      lines.push('', ';; ADDITIONAL SECTION:');
      lines.push(rr(target + '.', 3600, 'A', ip));
      hl.push('10 ' + target + '.', ip);
      label = 'DNS response: MX ' + target;
    } else {
      lines.push(';; ANSWER SECTION:');
      lines.push(rr(fqdn, ttl, 'A', ip));
      hl.push(ip, String(ttl).padEnd(8) + 'IN');
      label = 'DNS response: ' + ip;
    }

    var result = { ip: ip, nx: nx, target: target };
    tr.push({
      protocol: 'DNS', dir: 's2c', peer: 'resolver',
      label: label,
      transport: 'UDP ' + RESOLVER_IP + ':53 \u2192 ' + CLIENT_IP + ':' + port,
      raw: lines.join('\n'),
      highlight: hl,
      note: nx
        ? 'NXDOMAIN means "this name does not exist." The client stops here because there is nowhere to connect.'
        : 'The resolver may have asked root, top-level and authoritative servers first. The client only sees the final answer. The TTL says how many seconds it may be cached.',
      fields: nx
        ? [['status: NXDOMAIN', 'The name does not exist.']]
        : type === 'MX'
          ? [['MX 10', 'Preference 10. Lower numbers are tried first when a domain lists several mail servers.'],
             ['Additional section', 'The resolver also supplies the mail server\u2019s IP address so no second lookup is needed.'],
             ['TTL 3600', 'This answer may be cached for 3600 seconds.']]
          : [['Answer', 'The IP address to connect to.'],
             ['TTL ' + ttl, 'The client may cache this answer for ' + ttl + ' seconds.'],
             ['Flags qr ra', 'qr = this is a response. ra = recursion was available.']],
      ui: cb.answer(result)
    });
    result.answerIndex = tr.events.length - 1;
    return result;
  }

  /* ---------- URL and page helpers ---------- */
  function parseUrl(input) {
    var s = String(input || '').trim();
    if (!s) throw new Error('Type a web address, for example example.com');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    var u;
    try { u = new URL(s); } catch (e) { throw new Error('That does not look like a web address. Try example.com/page'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http:// and https:// addresses are supported.');
    if (u.hostname.indexOf('.') === -1) throw new Error('Add a domain ending, for example .com');
    var secure = u.protocol === 'https:';
    return {
      href: u.href,
      scheme: secure ? 'https' : 'http',
      host: u.hostname,
      port: u.port ? Number(u.port) : (secure ? 443 : 80),
      path: (u.pathname || '/') + u.search
    };
  }
  function pageBody(host, embedded) {
    var title = host === 'example.com' ? 'Example Domain' : host;
    return '<!doctype html>\n<html>\n<head>\n<title>' + title + '</title>\n' +
      (embedded ? '<link rel="stylesheet" href="/style.css">\n' : '') +
      '</head>\n<body>\n<h1>' + title + '</h1>\n' +
      (embedded ? '<img src="/logo.png" alt="logo">\n' : '') +
      '<p>This page was served by ' + host + '.</p>\n</body>\n</html>';
  }
  function shorten(s, n) { return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

  /* ======================================================================
     BROWSING: DNS -> (optional TCP/TLS) -> HTTP
     ====================================================================== */
  function browse(opts) {
    var u = parseUrl(opts.url);
    var persistent = opts.connection !== 'close';
    var connHdr = persistent ? 'keep-alive' : 'close';
    var showT = !!opts.showTransport;
    var secure = u.scheme === 'https';
    var notFound = /missing|404/i.test(u.path);
    var embedded = !!opts.embedded && !notFound;

    var tr = new Trace(hash(u.href + connHdr));
    var date = new Date();
    var rtt = tr.int(18, 45);

    var page = {
      state: 'loading', url: u.href, host: u.host, secure: secure,
      title: '', message: '', conns: 0,
      objects: [{ name: shorten(u.path, 22), done: false }]
    };
    if (embedded) page.objects.push({ name: '/style.css', done: false }, { name: '/logo.png', done: false });
    var total = page.objects.length;

    function snap(status, log) { return { status: status, log: log, page: JSON.parse(JSON.stringify(page)) }; }
    var meta = { serverIp: null, ipStep: null };

    /* 1. DNS */
    var dns = dnsExchange(tr, u.host, 'A', {
      query: function () { return snap('Looking up ' + u.host + '\u2026', 'Asked the DNS resolver for ' + u.host); },
      answer: function (r) {
        if (r.nx) {
          page.state = 'error';
          page.message = 'Server not found. ' + u.host + ' does not exist.';
          return snap('Could not find ' + u.host, 'DNS says ' + u.host + ' does not exist (NXDOMAIN)');
        }
        return snap('Found ' + u.host + ' at ' + r.ip, 'DNS answered: ' + u.host + ' is at ' + r.ip);
      }
    });
    if (dns.nx) return { events: tr.events, meta: meta };
    meta.serverIp = dns.ip;
    meta.ipStep = dns.answerIndex;
    var ip = dns.ip;

    /* 2. Connection helpers */
    var open = false, sport = 0;
    function tp(dir) {
      return dir === 'c2s' ? CLIENT_IP + ':' + sport + ' \u2192 ' + ip + ':' + u.port
                           : ip + ':' + u.port + ' \u2192 ' + CLIENT_IP + ':' + sport;
    }
    function openConn() {
      page.conns++;
      sport = tr.int(49152, 65000);
      open = true;
      if (!showT) return;
      tr.wait(1, 3);
      tr.push({
        protocol: 'TCP', dir: 'c2s', peer: 'server', label: 'TCP SYN',
        transport: 'TCP ' + tp('c2s'),
        raw: 'Flags: SYN\nSeq: 0\nWindow: 64240\nOptions: MSS 1460, SACK permitted',
        highlight: ['Flags: SYN'],
        note: 'Step 1 of the TCP three-way handshake: "I would like to open a connection."',
        ui: snap('Connecting to ' + ip + ':' + u.port + '\u2026', 'Opening TCP connection to ' + ip + ':' + u.port)
      });
      tr.wait(rtt, rtt + 6);
      tr.push({
        protocol: 'TCP', dir: 's2c', peer: 'server', label: 'TCP SYN-ACK',
        transport: 'TCP ' + tp('s2c'),
        raw: 'Flags: SYN, ACK\nSeq: 0  Ack: 1\nWindow: 65535\nOptions: MSS 1460',
        highlight: ['Flags: SYN, ACK'],
        note: 'Step 2: "Agreed, I am ready too."',
        ui: snap('Server answered, finishing the connection\u2026', null)
      });
      tr.wait(1, 2);
      tr.push({
        protocol: 'TCP', dir: 'c2s', peer: 'server', label: 'TCP ACK',
        transport: 'TCP ' + tp('c2s'),
        raw: 'Flags: ACK\nSeq: 1  Ack: 1',
        highlight: ['Flags: ACK'],
        note: 'Step 3: "Got it." The connection is open. Each new non-persistent connection pays for these three messages.',
        ui: snap('TCP connection open', 'TCP connection is open')
      });
      if (secure) {
        tr.wait(1, 3);
        tr.push({
          protocol: 'TLS', dir: 'c2s', peer: 'server', label: 'TLS ClientHello',
          transport: 'TLS ' + tp('c2s'),
          raw: 'Handshake: ClientHello\n  Versions: TLS 1.3\n  Server Name (SNI): ' + u.host + '\n  Cipher suites: TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384\n  Key share: x25519\n  ALPN: http/1.1',
          highlight: ['Server Name (SNI): ' + u.host],
          note: 'https:// means HTTP runs inside TLS. The client says which site it wants (SNI) and proposes encryption settings.',
          ui: snap('Securing the connection (TLS)\u2026', 'Started TLS handshake')
        });
        tr.wait(rtt, rtt + 12);
        tr.push({
          protocol: 'TLS', dir: 's2c', peer: 'server', label: 'TLS ServerHello + certificate',
          transport: 'TLS ' + tp('s2c'),
          raw: 'Handshake: ServerHello\n  Selected cipher suite: TLS_AES_128_GCM_SHA256\n  Key share: x25519\nHandshake (encrypted): EncryptedExtensions, Certificate, CertificateVerify, Finished\n  Certificate subject: CN=' + u.host,
          highlight: ['CN=' + u.host],
          note: 'The server picks the settings and proves its identity with a certificate for ' + u.host + '.',
          ui: snap('Checking the server certificate\u2026', null)
        });
        tr.wait(1, 3);
        tr.push({
          protocol: 'TLS', dir: 'c2s', peer: 'server', label: 'TLS Finished',
          transport: 'TLS ' + tp('c2s'),
          raw: 'Handshake (encrypted): Finished\n\nEverything after this point is encrypted.',
          highlight: ['Everything after this point is encrypted.'],
          note: 'From here on the HTTP messages travel encrypted. This visualizer shows them decrypted so you can read them.',
          ui: snap('Connection secured', 'TLS handshake finished')
        });
      }
    }
    function closeConn() {
      open = false;
      if (!showT) return;
      tr.wait(1, 3);
      tr.push({
        protocol: 'TCP', dir: 's2c', peer: 'server', label: 'TCP FIN (server closes)',
        transport: 'TCP ' + tp('s2c'),
        raw: 'Flags: FIN, ACK',
        highlight: ['Flags: FIN, ACK'],
        note: 'Because the response said Connection: close, the server ends the connection.',
        ui: snap('Server closed the connection', 'Server closed the TCP connection')
      });
      tr.wait(rtt, rtt + 4);
      tr.push({
        protocol: 'TCP', dir: 'c2s', peer: 'server', label: 'TCP FIN-ACK',
        transport: 'TCP ' + tp('c2s'),
        raw: 'Flags: FIN, ACK',
        highlight: ['Flags: FIN, ACK'],
        note: 'The client closes its side too. (The very last ACK is left out to keep the diagram short.)',
        ui: snap('Connection closed', null)
      });
    }

    /* 3. HTTP requests, one per file */
    var specs = [{
      path: u.path, main: true,
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
    }];
    if (embedded) {
      specs.push({
        path: '/style.css', accept: 'text/css,*/*;q=0.1', type: 'text/css',
        body: 'body { font-family: sans-serif; margin: 2rem; }'
      });
      specs.push({
        path: '/logo.png', accept: 'image/png,image/*;q=0.8,*/*;q=0.5', type: 'image/png',
        length: 4218, binLabel: '[4,218 bytes of PNG image data]'
      });
    }

    specs.forEach(function (sp, idx) {
      var reused = open;
      if (!open) openConn();
      tr.wait(1, 3);

      var rq = httpRequest({
        path: sp.path, host: u.host, port: u.port, scheme: u.scheme,
        accept: sp.accept, conn: connHdr,
        extra: sp.main ? [] : [['Referer', u.href]]
      });
      tr.push({
        protocol: 'HTTP', dir: 'c2s', peer: 'server',
        label: 'GET ' + shorten(sp.path, 22),
        transport: (secure ? 'HTTPS ' : 'HTTP ') + tp('c2s'),
        raw: rq.raw,
        highlight: ['GET ' + sp.path, 'Host: ' + rq.hostHdr, 'Connection: ' + connHdr],
        note: (reused && idx > 0 ? 'Same TCP connection as before: no new handshake. ' : '') +
          (sp.main ? 'The browser asks for the page. Each header line ends with CR+LF, and a blank line ends the headers.'
                   : 'The browser found this file mentioned in the HTML, so it asks for it too.'),
        fields: [
          ['Request line', 'Method (GET), path, and protocol version.'],
          ['Host', 'Which website on this server we want. One server can host many sites.'],
          ['Connection: ' + connHdr, persistent
            ? 'Keep the TCP connection open for more requests.'
            : 'Close the connection after this reply. The next file needs a new connection.']
        ],
        ui: snap('Requesting ' + sp.path + '\u2026', 'Sent GET ' + sp.path)
      });
      tr.wait(rtt, rtt + 60);

      var status = 200, reason = 'OK', type = sp.type || 'text/html; charset=UTF-8', body, len;
      if (sp.main) {
        if (notFound) {
          status = 404; reason = 'Not Found';
          body = '<html><body><h1>404 Not Found</h1></body></html>';
        } else {
          body = pageBody(u.host, embedded);
        }
        len = byteLen(body);
      } else if (sp.binLabel) {
        body = sp.binLabel; len = sp.length;
      } else {
        body = sp.body; len = byteLen(body);
      }

      var headers = [['Content-Type', type], ['Content-Length', String(len)], ['Connection', connHdr]];
      var isLast = idx === specs.length - 1;
      var statusLine = 'HTTP/1.1 ' + status + ' ' + reason;

      page.objects[idx].done = true;
      if (sp.main) {
        page.title = notFound ? '404 Not Found' : (u.host === 'example.com' ? 'Example Domain' : u.host);
        page.message = notFound ? 'The server has no page at ' + u.path : '';
      }
      var statusText, logText = 'Server replied ' + status + ' ' + reason + ' for ' + sp.path;
      if (isLast) {
        page.state = 'done';
        statusText = notFound ? 'Server replied 404 Not Found'
          : 'Page loaded (' + total + ' file' + (total > 1 ? 's' : '') + ', ' + page.conns + ' TCP connection' + (page.conns > 1 ? 's' : '') + ')';
      } else {
        statusText = 'Received ' + sp.path + ' (' + (idx + 1) + ' of ' + total + '), loading the rest\u2026';
      }

      tr.push({
        protocol: 'HTTP', dir: 's2c', peer: 'server',
        label: status + ' ' + reason + (sp.main ? '' : ' ' + shorten(sp.path, 14)),
        transport: (secure ? 'HTTPS ' : 'HTTP ') + tp('s2c'),
        raw: httpResponse({ status: status, reason: reason, date: date, headers: headers, body: body }),
        highlight: [statusLine, 'Content-Type: ' + type, 'Content-Length: ' + len],
        note: status === 404
          ? '404 means the server is reachable but has nothing at that path.'
          : (isLast && persistent
              ? 'With Connection: keep-alive the TCP connection stays open, so the next request would skip the handshake.'
              : 'The status line says how it went; the headers describe the body; the blank line separates them from the body.'),
        fields: [
          ['Status line', status + ' ' + reason + (status === 200 ? ': the request worked.' : ': the page was not found.')],
          ['Content-Type', 'What kind of data the body is, so the browser knows how to show it.'],
          ['Content-Length', 'Size of the body in bytes. Here it equals ' + fmtNum(len) + '.']
        ],
        ui: snap(statusText, logText)
      });

      if (!persistent) closeConn();
    });

    return { events: tr.events, meta: meta };
  }

  /* ======================================================================
     MAIL: DNS (MX lookup) -> SMTP conversation
     ====================================================================== */
  function encodeHeader(s) {
    if (/^[\x20-\x7e]*$/.test(s)) return s;
    var bytes = enc.encode(s), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return '=?UTF-8?B?' + btoa(bin) + '?=';
  }

  function mail(opts) {
    var from = String(opts.from || DEFAULT_SENDER).trim();
    var to = String(opts.to || '').trim();
    var subject = String(opts.subject || '').trim();
    if (!EMAIL_RE.test(from)) throw new Error('The From address is not valid. Use the form name@domain.com');
    if (!EMAIL_RE.test(to)) throw new Error('Enter a valid To address, for example bob@example.com');

    var domain = to.split('@')[1].toLowerCase();
    var tr = new Trace(hash(from + '|' + to + '|' + subject));
    var date = new Date();
    var rtt = tr.int(20, 50);
    var m = { state: 'sending', from: from, to: to, subject: subject, server: '', queueId: '', message: '' };
    function snap(status, log) { return { status: status, log: log, mail: JSON.parse(JSON.stringify(m)) }; }
    var meta = { serverIp: null, ipStep: null };

    var dns = dnsExchange(tr, domain, 'MX', {
      query: function () { return snap('Finding the mail server for ' + domain + '\u2026', 'Asked DNS for the mail server (MX) of ' + domain); },
      answer: function (r) {
        if (r.nx) {
          m.state = 'error';
          m.message = 'No mail server found: ' + domain + ' does not exist.';
          return snap('No mail server found for ' + domain, 'DNS says ' + domain + ' does not exist (NXDOMAIN)');
        }
        m.server = r.target;
        return snap('Mail server is ' + r.target, 'DNS answered: mail for ' + domain + ' goes to ' + r.target);
      }
    });
    if (dns.nx) return { events: tr.events, meta: meta };
    meta.serverIp = dns.ip;
    meta.ipStep = dns.answerIndex;
    var ip = dns.ip, mx = dns.target;
    var sport = tr.int(49152, 65000);
    var queueId = hex(tr.int(0x10000000, 0xFFFFFFFF), 8).toUpperCase();
    var msgId = '<' + hex(hash(from + to + subject + date.getTime()), 8) + '@cn-lab.local>';

    function say(dir, label, raw, hl, note, ui, fields, wait) {
      tr.wait(wait[0], wait[1]);
      tr.push({
        protocol: 'SMTP', dir: dir, peer: 'server', label: label,
        transport: dir === 'c2s'
          ? 'SMTP ' + CLIENT_IP + ':' + sport + ' \u2192 ' + ip + ':25'
          : 'SMTP ' + ip + ':25 \u2192 ' + CLIENT_IP + ':' + sport,
        raw: raw, highlight: hl, note: note, fields: fields, ui: ui
      });
    }

    /* 220 greeting: the SERVER speaks first */
    say('s2c', '220 greeting',
      '220 ' + mx + ' ESMTP Postfix' + CRLF,
      ['220'],
      'The client opened a TCP connection to port 25, and the server speaks first with a 220 greeting. Port 25 is used between mail servers; mail apps normally submit to port 587 with a login and STARTTLS. This simulation shows the plain SMTP conversation.',
      snap('Connected to ' + mx, 'Connected to ' + mx + ' (server says 220 ready)'),
      [['220', 'Reply code: service ready. SMTP replies start with a 3-digit code.']],
      [rtt, rtt + 20]);

    say('c2s', 'EHLO',
      'EHLO ' + CLIENT_HOST + CRLF,
      ['EHLO ' + CLIENT_HOST],
      'The client introduces itself. EHLO asks the server to list the extensions it supports.',
      snap('Introducing this computer to the server', 'Sent EHLO ' + CLIENT_HOST),
      [['EHLO', 'Extended HELLO. Followed by the client\u2019s own name.']],
      [1, 3]);

    say('s2c', '250 (extensions)',
      '250-' + mx + ' Hello ' + CLIENT_HOST + CRLF + '250-SIZE 35882577' + CRLF + '250-8BITMIME' + CRLF + '250-PIPELINING' + CRLF + '250 HELP' + CRLF,
      ['250-', '250 HELP'],
      'A multi-line reply. Every line except the last uses "250-" (dash). The last line uses "250 " (space), which tells the client the reply is finished.',
      snap('Server is ready to accept mail', 'Server replied 250 (extensions list)'),
      [['250-', 'More lines follow.'], ['250 (with space)', 'Last line of this reply.'], ['SIZE', 'Largest message the server will accept, in bytes.']],
      [rtt, rtt + 15]);

    say('c2s', 'MAIL FROM',
      'MAIL FROM:<' + from + '>' + CRLF,
      ['<' + from + '>'],
      'The envelope sender: who the message is from. This is separate from the From: header inside the message.',
      snap('Telling the server who the mail is from', 'Sent MAIL FROM:<' + from + '>'),
      [['MAIL FROM', 'Starts a new mail transaction and names the sender.']],
      [1, 3]);

    say('s2c', '250 OK',
      '250 2.1.0 Ok' + CRLF, ['250'],
      'The server accepts the sender.',
      snap('Sender accepted', 'Server replied 250 Ok (sender accepted)'),
      [['2.1.0', 'Enhanced status code: sender address accepted.']],
      [rtt, rtt + 10]);

    say('c2s', 'RCPT TO',
      'RCPT TO:<' + to + '>' + CRLF,
      ['<' + to + '>'],
      'The envelope recipient: who the message is for. This is the address the server uses for delivery.',
      snap('Telling the server who the mail is for', 'Sent RCPT TO:<' + to + '>'),
      [['RCPT TO', 'Names one recipient. It can be repeated for several recipients.']],
      [1, 3]);

    say('s2c', '250 OK',
      '250 2.1.5 Ok' + CRLF, ['250'],
      'The server accepts the recipient.',
      snap('Recipient accepted', 'Server replied 250 Ok (recipient accepted)'),
      [['2.1.5', 'Enhanced status code: recipient address accepted.']],
      [rtt, rtt + 10]);

    say('c2s', 'DATA',
      'DATA' + CRLF, ['DATA'],
      'The client asks permission to send the message itself.',
      snap('Asking to send the message content', 'Sent DATA'),
      [['DATA', 'Everything after the server\u2019s reply is message content, until a line with only a dot.']],
      [1, 3]);

    say('s2c', '354 go ahead',
      '354 End data with <CR><LF>.<CR><LF>' + CRLF, ['354'],
      '354 means "send it now." It is not a final answer: the server is still waiting for the end of the message.',
      snap('Server is ready for the message', 'Server replied 354 (go ahead)'),
      [['354', 'Intermediate reply: start mail input.']],
      [rtt, rtt + 10]);

    var bodyText = String(opts.body || '').replace(/\r\n|\r/g, '\n').replace(/\n+$/, '');
    var stuffed = bodyText.split('\n').map(function (l) { return l.charAt(0) === '.' ? '.' + l : l; });
    var headerLines = [
      'From: <' + from + '>',
      'To: <' + to + '>',
      'Subject: ' + encodeHeader(subject),
      'Date: ' + date.toUTCString().replace('GMT', '+0000'),
      'Message-ID: ' + msgId,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8'
    ];
    if (/[^\x00-\x7f]/.test(bodyText)) headerLines.push('Content-Transfer-Encoding: 8bit');
    var dataRaw = headerLines.join(CRLF) + CRLF + CRLF + stuffed.join(CRLF) + CRLF + '.' + CRLF;

    say('c2s', 'Message + "."',
      dataRaw,
      ['Subject: ' + encodeHeader(subject), CRLF + '.' + CRLF],
      'The message has headers, then a blank line, then the body. A line containing only "." ends it. If a body line starts with ".", the client adds an extra "." (dot-stuffing) so it is not mistaken for the end.',
      snap('Sending the message content', 'Sent message headers and body, ended with a lone "."'),
      [['Blank line', 'Separates headers from the body.'],
       ['Line with only "."', 'Tells the server the message is complete.'],
       ['Subject', 'Header shown in the recipient\u2019s inbox.']],
      [3, 8]);

    m.state = 'sent';
    m.queueId = queueId;
    say('s2c', '250 queued',
      '250 2.0.0 Ok: queued as ' + queueId + CRLF,
      ['250', 'queued as ' + queueId],
      'The server accepted responsibility for delivering the message and gave it a queue ID.',
      snap('Message accepted by ' + mx, 'Server replied 250 Ok: queued as ' + queueId),
      [['queued as ' + queueId, 'The server\u2019s reference for this message.']],
      [rtt + 10, rtt + 40]);

    say('c2s', 'QUIT',
      'QUIT' + CRLF, ['QUIT'],
      'The client ends the SMTP session politely.',
      snap('Closing the connection', 'Sent QUIT'),
      [['QUIT', 'Ends the session.']],
      [1, 3]);

    say('s2c', '221 bye',
      '221 2.0.0 Bye' + CRLF, ['221'],
      'The server closes the conversation. 221 means "service closing."',
      snap('Message sent', 'Server replied 221 Bye. Message sent.'),
      [['221', 'Service closing transmission channel.']],
      [rtt, rtt + 8]);

    return { events: tr.events, meta: meta };
  }

  /* ======================================================================
     STREAMING: DNS -> HTTP (master playlist, media playlist, segments)
     A session grows over time as the user plays, pauses and changes quality.
     ====================================================================== */
  var QUALITIES = {
    '480p':  { bandwidth: 1000000, res: '854x480',   bytes: 500000 },
    '720p':  { bandwidth: 2800000, res: '1280x720',  bytes: 1400000 },
    '1080p': { bandwidth: 5000000, res: '1920x1080', bytes: 2500000 }
  };

  function StreamSession() {
    this.quality = '720p';
    this.reset();
  }
  Object.defineProperty(StreamSession.prototype, 'events', {
    get: function () { return this.tr.events; }
  });
  StreamSession.prototype.reset = function () {
    this.tr = new Trace(4242, 0);
    this.date = new Date();
    this.started = false;
    this.playing = false;
    this.ended = false;
    this.state = 'idle';
    this.nextSeg = 1;
    this.fetched = 0;
    this.total = 10;
    this.ip = null;
    this.sport = 0;
    this.meta = { serverIp: null, ipStep: null };
  };
  StreamSession.prototype._ui = function (status, log) {
    return {
      status: status, log: log,
      video: { state: this.state, quality: this.quality, fetched: this.fetched, total: this.total }
    };
  };
  StreamSession.prototype._slice = function (fn) {
    var n = this.tr.events.length;
    fn();
    return this.tr.events.slice(n);
  };
  StreamSession.prototype._local = function (label, note, ui) {
    this.tr.push({ protocol: 'PLAYER', dir: 'local', peer: 'client', label: label, transport: 'Inside the video player (no network traffic)', raw: note, highlight: [], note: '', ui: ui });
  };
  // One HTTP request + response pair to the video server.
  StreamSession.prototype._http = function (path, o) {
    var self = this, tr = this.tr;
    var rq = httpRequest({ path: path, host: STREAM_HOST, port: 443, scheme: 'https', accept: o.accept, conn: 'keep-alive' });
    tr.push({
      protocol: 'HTTP', dir: 'c2s', peer: 'server', label: 'GET ' + o.short,
      transport: 'HTTPS ' + CLIENT_IP + ':' + this.sport + ' \u2192 ' + this.ip + ':443',
      raw: rq.raw,
      highlight: ['GET ' + path, 'Host: ' + STREAM_HOST],
      note: o.noteReq, fields: o.fieldsReq,
      ui: o.uiReq()
    });
    tr.wait(o.wait[0], o.wait[1]);
    var len = o.body != null ? byteLen(o.body) : o.length;
    var shown = o.body != null ? o.body : o.binLabel;
    var headers = [['Content-Type', o.type], ['Content-Length', String(len)], ['Cache-Control', o.cache], ['Connection', 'keep-alive']];
    tr.push({
      protocol: 'HTTP', dir: 's2c', peer: 'server', label: '200 OK ' + o.short,
      transport: 'HTTPS ' + this.ip + ':443 \u2192 ' + CLIENT_IP + ':' + this.sport,
      raw: httpResponse({ status: 200, reason: 'OK', date: self.date, headers: headers, body: shown }),
      highlight: ['HTTP/1.1 200 OK', 'Content-Type: ' + o.type, 'Content-Length: ' + len],
      note: o.noteRes, fields: o.fieldsRes,
      ui: o.uiRes()
    });
  };
  StreamSession.prototype._masterPlaylist = function () {
    var self = this;
    var body = ['#EXTM3U', '#EXT-X-VERSION:3'];
    Object.keys(QUALITIES).forEach(function (q) {
      body.push('#EXT-X-STREAM-INF:BANDWIDTH=' + QUALITIES[q].bandwidth + ',RESOLUTION=' + QUALITIES[q].res);
      body.push(q + '/index.m3u8');
    });
    this._http('/stream/master.m3u8', {
      short: 'master.m3u8', accept: 'application/vnd.apple.mpegurl,*/*', type: 'application/vnd.apple.mpegurl',
      cache: 'no-cache', wait: [this.tr.int(20, 40), this.tr.int(41, 80)], body: body.join('\n') + '\n',
      noteReq: 'HLS streaming starts with a playlist. The master playlist lists the available qualities. It is fetched over ordinary HTTP.',
      fieldsReq: [['.m3u8', 'A playlist file (plain text) used by HTTP Live Streaming.']],
      uiReq: function () { return self._ui('Downloading the playlist\u2026', 'Requested master playlist'); },
      noteRes: 'Each EXT-X-STREAM-INF line describes one quality (bandwidth and resolution) and points to its own playlist.',
      fieldsRes: [['BANDWIDTH', 'Bits per second this quality needs.'], ['RESOLUTION', 'Frame size of this quality.']],
      uiRes: function () { return self._ui('Playlist received: 3 quality levels', 'Got master playlist (480p, 720p, 1080p)'); }
    });
  };
  StreamSession.prototype._mediaPlaylist = function (q, switching) {
    var self = this;
    var body = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0'];
    for (var n = 1; n <= this.total; n++) {
      body.push('#EXTINF:4.000,');
      body.push('seg' + String(n).padStart(3, '0') + '.ts');
    }
    body.push('#EXT-X-ENDLIST');
    this._http('/stream/' + q + '/index.m3u8', {
      short: q + '/index.m3u8', accept: 'application/vnd.apple.mpegurl,*/*', type: 'application/vnd.apple.mpegurl',
      cache: 'no-cache', wait: [this.tr.int(20, 40), this.tr.int(41, 70)], body: body.join('\n') + '\n',
      noteReq: switching
        ? 'To change quality, the player downloads the playlist for the new quality. Later segments will come from that quality\u2019s folder.'
        : 'The player picks one quality and downloads its playlist, which lists every video segment in order.',
      fieldsReq: [['/stream/' + q + '/', 'Folder for this quality.']],
      uiReq: function () { return self._ui((switching ? 'Switching to ' : 'Choosing ') + q + '\u2026', 'Requested the ' + q + ' playlist'); },
      noteRes: 'Each EXTINF line is one 4-second segment. The player will now request these segments one by one, each as a separate HTTP GET.',
      fieldsRes: [['EXTINF:4.000', 'Length of the next segment in seconds.'], ['seg001.ts', 'File name of the segment.'], ['EXT-X-ENDLIST', 'The video has a known end.']],
      uiRes: function () { return self._ui('Now streaming at ' + q, 'Got the ' + q + ' playlist'); }
    });
  };
  StreamSession.prototype._segment = function (buffering) {
    var self = this, tr = this.tr, q = this.quality;
    var n = this.nextSeg++;
    var name = 'seg' + String(n).padStart(3, '0') + '.ts';
    var path = '/stream/' + q + '/' + name;
    var len = Math.round(QUALITIES[q].bytes * (0.92 + tr.rand() * 0.16));
    this._http(path, {
      short: name, accept: '*/*', type: 'video/mp2t', cache: 'public, max-age=86400',
      wait: [tr.int(30, 60), tr.int(61, 140)], length: len, binLabel: '[' + fmtNum(len) + ' bytes of MPEG-TS video data]',
      noteReq: n === 1
        ? 'Video is delivered as many small files. This is a normal HTTP GET, sent on a persistent connection (keep-alive), so no new handshake is needed.'
        : 'Next 4-second piece of video, requested from the ' + q + ' folder.',
      fieldsReq: [['/' + q + '/', 'The quality folder chosen by the player.'], [name, 'Segment ' + n + ' of ' + this.total + '.']],
      uiReq: function () {
        return self._ui(buffering ? 'Buffering: segment ' + n + ' of ' + self.total + '\u2026' : 'Playing ' + q + ': fetching segment ' + n + ' of ' + self.total,
          'Requested segment ' + n);
      },
      noteRes: 'The body is video data, so it is shown as a label. Content-Length tells the player how many bytes to expect. Higher quality means bigger segments.',
      fieldsRes: [['video/mp2t', 'The segment is MPEG transport stream video.'], ['Content-Length', fmtNum(len) + ' bytes for 4 seconds at ' + q + '.']],
      uiRes: function () {
        self.fetched++;
        return self._ui(buffering ? 'Buffered segment ' + n + ' of ' + self.total : 'Playing ' + q + ': segment ' + n + ' of ' + self.total + ' received',
          'Got segment ' + n + ' (' + fmtNum(len) + ' bytes, ' + q + ')');
      }
    });
  };

  StreamSession.prototype.play = function () {
    var self = this;
    return this._slice(function () {
      if (self.playing || self.ended) return;
      var tr = self.tr;
      if (self.started) {                                  // resume after pause
        self.state = 'playing'; self.playing = true;
        tr.wait(200, 600);
        self._local('Play pressed: resume',
          'The player starts asking for segments again, on the same open connection.',
          self._ui('Playing ' + self.quality, 'Playback resumed'));
        return;
      }
      self.started = true;
      self.state = 'buffering';
      var dns = dnsExchange(tr, STREAM_HOST, 'A', {
        query: function () { return self._ui('Looking up ' + STREAM_HOST + '\u2026', 'Asked the DNS resolver for ' + STREAM_HOST); },
        answer: function (r) { self.ip = r.ip; return self._ui('Found ' + STREAM_HOST + ' at ' + r.ip, 'DNS answered: ' + STREAM_HOST + ' is at ' + r.ip); }
      });
      self.meta.serverIp = dns.ip;
      self.meta.ipStep = dns.answerIndex;
      self.sport = tr.int(49152, 65000);
      tr.wait(4, 10);
      self._masterPlaylist();
      tr.wait(2, 6);
      self._mediaPlaylist(self.quality, false);
      for (var i = 0; i < 3; i++) { tr.wait(2, 6); self._segment(true); }
      tr.wait(20, 60);
      self.state = 'playing'; self.playing = true;
      self._local('Buffer ready: video starts',
        'Three segments (12 seconds of video) are buffered, so playback begins. From now on the player requests one new segment for every 4 seconds it plays.',
        self._ui('Playing ' + self.quality, 'Playback started'));
    });
  };

  StreamSession.prototype.pause = function () {
    var self = this;
    return this._slice(function () {
      if (!self.playing) return;
      self.playing = false; self.state = 'paused';
      self.tr.wait(300, 900);
      self._local('Paused: no new segment requests',
        'The player already holds segments up to ' + self.fetched + '. It stops asking for more until Play is pressed. (Real players keep filling a larger buffer first, then stop.)',
        self._ui('Paused', 'Paused. Segment requests stop.'));
    });
  };

  StreamSession.prototype.setQuality = function (q) {
    var self = this;
    if (!QUALITIES[q] || q === this.quality) return [];
    if (!this.started || this.ended) { this.quality = q; return []; }
    return this._slice(function () {
      self.quality = q;
      self.tr.wait(150, 500);
      self._local('Quality changed to ' + q,
        'The viewer picked ' + q + '. The player needs that quality\u2019s playlist before it can request its segments.',
        self._ui('Switching to ' + q + '\u2026', 'Quality changed to ' + q));
      self.tr.wait(2, 6);
      self._mediaPlaylist(q, true);
    });
  };

  StreamSession.prototype.tick = function () {
    var self = this;
    return this._slice(function () {
      if (!self.playing) return;
      var tr = self.tr;
      if (self.nextSeg > self.total) {
        self.playing = false; self.ended = true; self.state = 'ended';
        tr.wait(3500, 4200);
        self._local('Video finished',
          'All ' + self.total + ' segments were played, and the playlist ended with EXT-X-ENDLIST. No more requests.',
          self._ui('Video finished', 'Video finished'));
        return;
      }
      tr.wait(3600, 4200);
      self._segment(false);
    });
  };

  global.Sim = {
    browse: browse,
    mail: mail,
    StreamSession: StreamSession,
    CLIENT_IP: CLIENT_IP,
    RESOLVER_IP: RESOLVER_IP,
    STREAM_HOST: STREAM_HOST,
    DEFAULT_SENDER: DEFAULT_SENDER,
    QUALITIES: QUALITIES
  };
})(typeof window !== 'undefined' ? window : globalThis);
