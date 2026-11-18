/**
 * Optional, free feed proxy for podcasts whose servers block browsers (e.g. NPR shows).
 * Paste into a new project at script.google.com, then Deploy > New deployment > Web app,
 * Execute as: Me, Who has access: Anyone. Put the /exec URL in Podplayer's Settings.
 * It returns podcast feeds only (RSS/Atom text), never audio.
 */
function doGet(e) {
  var url = (e && e.parameter && e.parameter.url) || '';
  if (!/^https?:\/\//i.test(url)) return text_('Missing url');
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  var body = res.getContentText();
  if (res.getResponseCode() >= 400) return text_('Upstream error ' + res.getResponseCode());
  if (!/<(rss|feed|opml)[\s>]/i.test(body.slice(0, 5000))) return text_('Not a podcast feed');
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.XML);
}

function text_(msg) {
  return ContentService.createTextOutput(msg).setMimeType(ContentService.MimeType.TEXT);
}
