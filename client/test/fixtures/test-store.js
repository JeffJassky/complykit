// A minimal consent store for gate tests: the GateStore interface
// ({ isGranted, subscribe }) plus set() to drive it from the test.
window.TestStore = {
  granted: {},
  listeners: [],
  isGranted: function (id) { return this.granted[id] === true; },
  subscribe: function (fn) {
    this.listeners.push(fn);
    var self = this;
    return function () { self.listeners = self.listeners.filter(function (f) { return f !== fn; }); };
  },
  set: function (id, on) {
    this.granted[id] = on;
    this.listeners.slice().forEach(function (fn) { fn(); });
  },
  notify: function () { this.listeners.slice().forEach(function (fn) { fn(); }); },
};
window.TestConfig = { categories: [{ id: 'necessary' }, { id: 'analytics' }, { id: 'marketing' }], gate: [] };
