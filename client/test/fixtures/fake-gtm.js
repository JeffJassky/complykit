// Fake GTM container (GTM-XXXX01): defines dataLayer and records every push.
window.dataLayer = window.dataLayer || [];
window.google_tag_manager = { 'GTM-XXXX01': { dataLayer: { get: function () { return undefined; } } } };
window.dataLayer.push({ 'gtm.start': 0, event: 'gtm.js' });
