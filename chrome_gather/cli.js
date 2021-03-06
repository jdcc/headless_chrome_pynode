const fs = require('fs');
const puppeteer = require('puppeteer');
const { promisify } = require('util');
const chromeHar = require('chrome-har-capturer');
const program = require('commander');

function parse(i) {
  return parseInt(i);
}

function detectFalse(s) {
  return s.toLowerCase().trim() === 'false' ? false : s;
}

program
    .usage('[options] URL')
    .option('-w, --width <px>', 'browser width in pixels', parse, 1200)
    .option('-h, --height <px>', 'browser height in pixels', parse, 800)
    .option('-o, --har <file>', 'file to write HAR to', detectFalse, 'capture.har')
    .option('-s, --screenshot <file>', 'file to write the screenshot to', detectFalse, 'capture.png')
    .option('-e, --events <file>', 'file to write the events log to', false)
    .option('-c, --js <code>', 'javascript to evaluate in page context', detectFalse, false)
    .option('-r, --jsresult <file>', 'file to write the result of ' +
      'running --js to', detectFalse, false)
    .option('-p, --port <integer>', 'remote debugging port to use for Chrome',
      parse, 9222)
    .option('-t, --timeout <integer>', 'wait this many milliseconds for page to load',
      parse, 60 * 1000)
    .parse(process.argv);

if (program.args.length === 0) {
    program.outputHelp();
    process.exit(1);
}

const url = program.args[0];

let events = [];
const observe = [
  'Page.loadEventFired',
  'Page.domContentEventFired',
  'Page.frameStartedLoading',
  'Page.frameAttached',
  'Network.requestWillBeSent',
  'Network.requestServedFromCache',
  'Network.dataReceived',
  'Network.responseReceived',
  'Network.resourceChangedPriority',
  'Network.loadingFinished',
  'Network.loadingFailed',
];

function addEmptyResponse(requestId) {
  const content = {
    requestId: requestId,
    body: '',
    base64Encoded: false
  };
  events.push({ method: 'Network.getResponseBody', params: content });
}

function fetchContent(client, requestId) {
  return new Promise(function(resolve, reject) {
    client.send('Network.getResponseBody', { requestId })
      .then(content => {
        content.requestId = requestId;
        events.push({ method: 'Network.getResponseBody', params: content });
        resolve();
      }).catch(err => {
        console.warn('No response data for request "' + requestId + '"');
        // This usually fails when there is a zero length response or a 204 (No
        // Content) response, so it's usually OK to just create an empty body.
        addEmptyResponse(requestId);
        resolve();
      });
  });
}

function difference(setA, setB) {
    var _difference = new Set(setA);
    for (var elem of setB) {
        _difference.delete(elem);
    }
    return _difference;
}

function tallyResponses() {
  let loaded = new Set();
  let bodies = new Set();
  events.forEach(e => {
    if (e.method === 'Network.loadingFinished') {
      loaded.add(e.params.requestId);
    } else if (e.method === 'Network.getResponseBody') {
      bodies.add(e.params.requestId);
    }
  });
  console.log('Loaded: ' + loaded.size + ' Bodies: ' + bodies.size);
  const diff = difference(loaded, bodies);
  diff.forEach(addEmptyResponse);
}

(async () => {
  try {
    let args = [ '--remote-debugging-port=' + program.port ];
    // This is terrible, but Chrome makes us run with no sandbox if we're running
    // as root.
    if (process.env.USER === 'root') {
      args.push('--no-sandbox');
    }
    const browser = await puppeteer.launch({ args: args });
    const page = await browser.newPage();
    const contentPromises = [];
    const requestIds = new Set();

    // register events listeners
    const client = await page.target().createCDPSession();

    if (program.har) {
      await client.send('Page.enable');
      await client.send('Network.enable');
      observe.forEach(method => {
        client.on(method, params => {
          events.push({ method, params });
          if (method === 'Network.loadingFinished') {
            requestIds.add(params.requestId);
          }
        });
      });
    }

    // This attempts to handle "Page crash" errors. See
    // https://github.com/GoogleChrome/puppeteer/issues/1454
    // and
    // https://github.com/GoogleChrome/puppeteer/issues/1862
    page.on('error', err => {
      console.error(err);
      process.exit(1);
    });

    await page.setViewport({ width: program.width, height: program.height });
    await page.goto(url, { timeout: program.timeout, waitUntil: 'load' });

    if (program.js) {
      const result = await page.evaluate(program.js);
      if (program.jsresult) {
        await promisify(fs.writeFile)(program.jsresult, JSON.stringify(result).trim());
      }
    }

    if (program.screenshot) {
      await page.screenshot({path: program.screenshot, fullPage: true});
    }

    if (program.har) {
      await Promise.all(Array.from(requestIds).map(rid => fetchContent(client, rid)));
      tallyResponses();
    }

    if (program.events) {
      fs.writeFile(program.events, JSON.stringify(events));
    }

    if (program.har) {
      let har;
      try {
        har = await chromeHar.fromLog(url, events, { content: true });
      } catch (e) {
        console.warn(e.message);
        har = await chromeHar.fromLog(url, events);
      }
      await promisify(fs.writeFile)(program.har, JSON.stringify(har));
    }

    await browser.close();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
