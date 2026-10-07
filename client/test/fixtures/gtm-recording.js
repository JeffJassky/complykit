// Fake GTM container (GTM-XXXX01) that records the data layer the way the real
// one reads it: everything queued before it ran (`__gtmQueueAtLoad`), then
// every later push (`__gtmPushes`). Arguments objects (gtag commands) are kept
// apart from plain objects (data pushes), because GTM treats them differently.
(function () {
  function describe(e) {
    if (Object.prototype.toString.call(e) === '[object Arguments]') {
      return { kind: 'command', args: JSON.parse(JSON.stringify(Array.prototype.slice.call(e))) };
    }
    return { kind: 'data', value: JSON.parse(JSON.stringify(e)) };
  }
  var dl = (window.dataLayer = window.dataLayer || []);
  window.__gtmQueueAtLoad = dl.map(describe);
  window.__gtmPushes = [];
  var push = dl.push;
  dl.push = function () {
    for (var i = 0; i < arguments.length; i++) window.__gtmPushes.push(describe(arguments[i]));
    return push.apply(dl, arguments);
  };
  window.google_tag_manager = { 'GTM-XXXX01': { dataLayer: { get: function () { return undefined; } } } };
})();
