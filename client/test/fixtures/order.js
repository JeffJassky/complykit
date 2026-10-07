// Records its own ?n= tag in window.__order; served via /slow/ with ?ms= delays.
(function () {
  var s = document.currentScript;
  var n = new URL(s.src).searchParams.get('n');
  (window.__order || (window.__order = [])).push(n);
  (window.__ran || (window.__ran = {}))[n] = ((window.__ran || {})[n] || 0) + 1;
})();
