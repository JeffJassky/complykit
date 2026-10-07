// Fake consent-vendor API global: records calls so tests can assert on them.
window.FakeConsentVendor = {
  calls: [],
  setConsent: function (categories) { this.calls.push(['setConsent', categories]); },
  getConsent: function () { return { analytics: false, marketing: false }; },
};
