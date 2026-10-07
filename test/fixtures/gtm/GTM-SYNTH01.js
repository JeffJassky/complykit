// Fixture: a SYNTHETIC container in the shape of a served gtm.js, exercising what the three
// captured containers do not: explicit "additional consent" lists, a blocking rule, an `unless`
// clause, a Consent Initialization trigger, tag sequencing, a Custom Image tag, a Custom HTML
// Meta Pixel snippet, a sandboxed template that reads consent and sets defaults, a gallery
// template nothing can place, a vendor template GTM ships, and a consent setting that is not a
// plain list. No real site is behind it.

// Copyright 2012 Google Inc. All rights reserved.

(function(){

var data = {
"resource": {
  "version":"7",

  "macros":[{"function":"__e"},{"function":"__u","vtp_component":"URL","vtp_enableMultiQueryKeys":false,"vtp_enableIgnoreEmptyQueryParam":false},{"function":"__u","vtp_component":"PATH","vtp_enableMultiQueryKeys":false,"vtp_enableIgnoreEmptyQueryParam":false},{"function":"__v","vtp_name":"gtm.triggers","vtp_dataLayerVersion":2,"vtp_setDefaultValue":true,"vtp_defaultValue":""},{"function":"__v","vtp_name":"ecommerce.value","vtp_dataLayerVersion":2},{"function":"__c","vtp_value":"G-XXXXXXXX01"},{"function":"__k","vtp_name":"consent_choice","vtp_decodeCookie":false},{"function":"__cvt_SYN01","vtp_key":"user_id"}],
  "tags":[
    {"function":"__googtag","metadata":["map"],"once_per_event":true,"vtp_tagId":["macro",5],"vtp_configSettingsTable":["list",["map","parameter","send_page_view","parameterValue","true"]],"tag_id":1},
    {"function":"__gaawe","metadata":["map"],"once_per_event":true,"vtp_eventName":"purchase","vtp_measurementIdOverride":"G-XXXXXXXX01","vtp_eventSettingsTable":["list",["map","parameter","value","parameterValue",["macro",4]]],"consent":["list","analytics_storage"],"tag_id":2},
    {"function":"__html","metadata":["map"],"once_per_event":true,"vtp_html":"<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','000000000000001');fbq('track','PageView');</script>","vtp_supportDocumentWrite":false,"consent":["list","ad_storage","ad_user_data"],"tag_id":3},
    {"function":"__html","metadata":["map"],"once_per_event":true,"vtp_html":"<script>(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};h._hjSettings={hjid:1,hjsv:6};a=o.getElementsByTagName('head')[0];r=o.createElement('script');r.async=1;r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;a.appendChild(r);})(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');</script>","vtp_supportDocumentWrite":false,"tag_id":4},
    {"function":"__img","metadata":["map"],"once_per_event":true,"vtp_useCacheBuster":true,"vtp_url":"https://ct.pinterest.com/v3/?tid=0000000000001&event=pagevisit","vtp_cacheBusterQueryParam":"gtmcb","vtp_randomNumber":["macro",0],"tag_id":5},
    {"function":"__cvt_SYN01","once_per_event":true,"vtp_projectId":"abc0123xyz","tag_id":6},
    {"function":"__cvt_SYN02","once_per_event":true,"vtp_accountId":"id-redacted-01","tag_id":7},
    {"function":"__baut","metadata":["map"],"once_per_event":true,"vtp_uetTagId":"00000001","vtp_eventType":"PAGE_LOAD","vtp_tagId":"00000001","tag_id":8},
    {"function":"__cvt_SYN03","once_per_event":true,"vtp_cookieName":"consent_choice","tag_id":9},
    {"function":"__awct","metadata":["map"],"once_per_event":true,"vtp_conversionId":"AW-XXXXXXXX02","vtp_conversionLabel":"abcDEFghi","vtp_enableConversionLinker":true,"setup_tags":["list",["tag",0,0]],"consent":["macro",6],"tag_id":10},
    {"function":"__cl","tag_id":11},
    {"function":"__frobnicate","metadata":["map"],"once_per_event":true,"vtp_siteId":"xyz","tag_id":12}
  ],
  "predicates":[{"function":"_eq","arg0":["macro",0],"arg1":"gtm.js"},{"function":"_eq","arg0":["macro",0],"arg1":"gtm.init_consent"},{"function":"_eq","arg0":["macro",0],"arg1":"purchase"},{"function":"_cn","arg0":["macro",2],"arg1":"/checkout/"},{"function":"_re","arg0":["macro",1],"arg1":"^https://example-1\\.test/(admin|preview)/","ignore_case":true},{"function":"_eq","arg0":["macro",0],"arg1":"gtm.click"},{"function":"_re","arg0":["macro",3],"arg1":"(^$|((^|,)1000001_11($|,)))"},{"function":"_eq","arg0":["macro",0],"arg1":"gtm.dom"}],
  "rules":[[["if",1],["add",9]],[["if",0],["add",0,2,3,4,10,11]],[["if",2],["add",1]],[["if",0,3],["add",7]],[["if",4],["block",2,3]],[["if",5,6],["add",5]],[["if",7],["unless",3],["add",6]],[["if",0],["add",8]]]
},
"runtime":[
 [50,"__cvt_SYN01",[46,"a"],[52,"b",["require","injectScript"]],[52,"c",["require","isConsentGranted"]],[52,"d",["require","queryPermission"]],[22,["c","analytics_storage"],[46,["b","https://cdn.example-vendor.test/tag.js",[17,[15,"a"],"gtmOnSuccess"],[17,[15,"a"],"gtmOnFailure"]]],[46,[2,[15,"a"],"gtmOnSuccess",[7]]]]],
 [50,"__cvt_SYN02",[46,"a"],[52,"b",["require","sendPixel"]],["b",[0,"https://px.ads.linkedin.com/collect?pid=",[17,[15,"a"],"accountId"]],[17,[15,"a"],"gtmOnSuccess"],[17,[15,"a"],"gtmOnFailure"]]],
 [50,"__cvt_SYN03",[46,"a"],[52,"b",["require","setDefaultConsentState"]],[52,"c",["require","updateConsentState"]],[52,"d",["require","getCookieValues"]],["b",[8,"ad_storage","denied","analytics_storage","denied"]],[2,[15,"a"],"gtmOnSuccess",[7]]]
],
"permissions":{"__cvt_SYN01":{"inject_script":{"urls":["https://cdn.example-vendor.test/*"]},"access_consent":{"consentTypes":[{"consentType":"analytics_storage","read":true,"write":false}]}},"__cvt_SYN02":{"send_pixel":{"urls":["https://px.ads.linkedin.com/*"]}},"__cvt_SYN03":{"access_consent":{"consentTypes":[{"consentType":"ad_storage","read":true,"write":true},{"consentType":"analytics_storage","read":true,"write":true}]},"get_cookies":{"cookieAccess":"specific","cookieNames":["consent_choice"]}}},
"sandboxed_scripts":["__cvt_SYN01","__cvt_SYN02","__cvt_SYN03"]
};

/* … runtime code removed for the fixture … */

})();
