
const SHEET_NAME = "Vendor System Status"; 

// Only including vendors that typically allow API access  
const FEEDS = {
    "Microsoft": "https://portal.office.com/api/servicestatus/index",
    "Google": "https://www.google.com/appsstatus/dashboard/incidents.json",
    "OpenAI": "https://status.openai.com/api/v2/summary.json",
    "Cloudflare": "https://www.cloudflarestatus.com/api/v2/summary.json",
    "Calendly": "https://www.calendlystatus.com/api/v2/summary.json",
    "Zoom": "https://status.zoom.us/api/v2/summary.json",
    "HubSpot": "https://status.hubspot.com/api/v2/summary.json",
    "Monday.com": "https://status.monday.com/api/v2/summary.json",
    "Lucid": "https://status.lucid.co/api/v2/summary.json",
    "Jamf": "https://status.jamf.com/api/v2/summary.json",
    "KnowBe4": "https://status.knowbe4.com/api/v2/summary.json",
    "Seismic": "https://status.seismic.com/api/v2/summary.json",
    "Navan": "https://status.navan.com/api/v2/summary.json",
    "Loopio": "https://www.loopiostatus.com/api/v2/summary.json",
    "Centage": "https://status.centage.com/api/v2/summary.json",
    "Celigo": "https://status.celigo.com/api/v2/summary.json",
    "Zapier": "https://status.zapier.com/api/v2/summary.json",
    "GitHub": "https://www.githubstatus.com/api/v2/summary.json",
    "Docusign": "https://status.docusign.com/api/v2/summary.json",
    "SendGrid": "https://status.sendgrid.com/api/v2/summary.json",
    "NetSuite": "https://status.netsuite.com",
    "Apple": "https://www.apple.com/support/systemstatus/data/system_status_en_US.js",
    "Alteryx": "https://status.alteryxcloud.com/api/v2/summary.json",
    "Concur": "https://open.concur.com",
    // Temporarily disabled Tableau feed until revisit/fix
    // "Tableau": "https://status.salesforce.com/products/Tableau"
    "Stormboard": "https://status.stormboard.com/api/v2/summary.json",
    // "iorad": "https://status.iorad.com/api/v2/summary.json"
    // "Okta": "https://www.oktaportal.com/api/v2/summary.json",
    // Paylocity
    // "Couchdrop": "https://status.couchdrop.io/status.json",
    // "FreshDesk / FreshService": "https://status.freshworks.com/api/v2/summary.json",
    "Qualtrics": "https://status.qualtrics.com/api/v2/summary.json",
    // "DSI": "https://www.datasolutionsinc.com",
    // "QuantumWorkplace": "https://status.quantumworkplace.com",
    // "gPanel": "https://status.promevo.com"
};

const FILTERS = {
  "OpenAI": ["ChatGPT", "API"],
  "Cloudflare": ["Dashboard", "DNS", "Workers"],
  "Zoom": ["Zoom Meetings", "Zoom Phone"]
  // Tableau filter temporarily disabled while feed is commented out
  // "Tableau": ["Tableau Cloud"]
};

const HEADERS = ["vendor","service","status","incident_name","description","impact","started_at","updated_at","source_url","last_checked"];

function refreshVendorStatus() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  ensureHeaders_(sheet);

  const nowIso = new Date().toISOString();
  const rows = [];
  
  // 1. Google (Collapsed Logic)
  try { rows.push(...fetchGoogleAppsStatus_("Google", FEEDS["Google"], nowIso)); } catch(e) { Logger.log("Google error: " + e); }

  // 2. Microsoft
  try { rows.push(...fetchMicrosoftStatus_("Microsoft", FEEDS["Microsoft"], nowIso)); } catch(e) { Logger.log("MS error: " + e); }
  
  // 3. NetSuite
  try { 
    const nsData = fetchNetSuiteStatus_("NetSuite", FEEDS["NetSuite"], nowIso);
    if (nsData) rows.push(nsData); 
  } catch(e) { Logger.log("NS error: " + e); }

  // 4. Apple
  try { 
    const appleData = fetchAppleStatus_("Apple", FEEDS["Apple"], nowIso);
    if (appleData) rows.push(appleData);
  } catch(e) { Logger.log("Apple error: " + e); }

  // 5. Concur (Added Custom Handler)
  try {
    const concurData = fetchConcurStatus_("Concur", FEEDS["Concur"], nowIso);
    if (concurData) rows.push(concurData);
  } catch(e) { Logger.log("Concur error: " + e); }

  // 6. Tableau handler temporarily disabled — feed commented out for later revisit
  /*
  try {
    const tableauData = fetchTableauStatus_("Tableau", FEEDS["Tableau"], nowIso);
    if (tableauData && tableauData.length > 0) rows.push(...tableauData);
  } catch(e) { Logger.log("Tableau error: " + e); }
  */

  // Stormboard (custom handler - some sites return HTML rather than JSON)
  try {
    const stormData = fetchStormboardStatus_("Stormboard", FEEDS["Stormboard"], nowIso);
    if (stormData && stormData.length > 0) rows.push(...stormData);
  } catch(e) { Logger.log("Stormboard error: " + e); }

  // 6. Automated Loop
  Object.keys(FEEDS).forEach(vendor => {
    // IMPORTANT: Added "Concur" and "Tableau" to this ignore list so the loop skips them
    if (["Google", "Microsoft", "NetSuite", "Apple", "Concur", "Tableau", "Stormboard"].includes(vendor)) return;
    
    try {
      const statusData = fetchStatuspageSummary_(vendor, FEEDS[vendor], nowIso, FILTERS[vendor]);
      if (statusData && statusData.length > 0) rows.push(...statusData);
    } catch(e) { Logger.log("Skipping " + vendor + " due to API error: " + e); }
  });

  // Final Writing Logic
  if (rows.length > 0) {
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).clearContent();
    }
    sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
    
    // MULTI-LEVEL SORT:
    // 1. Status (D before O, so Degraded appears at top)
    // 2. Vendor (A-Z)
    // 3. Service (A-Z)
    sheet.getRange(2, 1, rows.length, HEADERS.length).sort([
      {column: 3, ascending: true}, 
      {column: 1, ascending: true}, 
      {column: 2, ascending: true}
    ]);
    
    Logger.log("Successfully wrote and multi-sorted " + rows.length + " rows.");
    // Flag Tableau rows in-sheet so it's visible that this feed needs revisit
    try {
      flagTableauRow_(sheet);
    } catch(e) { Logger.log('Flagging Tableau row failed: ' + e); }
  }
}

// --- Stormboard handler (handles JSON or HTML) ---
function fetchStormboardStatus_(vendor, url, nowIso) {
  try {
    const resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true, headers: {"Accept": "application/json, text/html"}});
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    if (code === 200) {
      const headers = resp.getHeaders ? resp.getHeaders() : {};
      const contentType = (headers['Content-Type'] || headers['content-type'] || '').toString().toLowerCase();
      // If JSON-looking response, parse and reuse the generic summary mapping
      if (contentType.indexOf('application/json') !== -1 || body.trim().startsWith('{')) {
        try {
          const data = JSON.parse(body);
          if (data && (data.components || data.incidents)) {
            const generalUrl = (data.page && data.page.url) ? data.page.url : url;
            const activeIncidents = (data.incidents || []).filter(i => i.status !== 'resolved');
            if (activeIncidents.length === 0) return [[vendor, vendor, "Operational", "n/a", "Systems operational.", "none", "", "", generalUrl, nowIso]];
            return activeIncidents.map(i => {
              const updateBody = (i.incident_updates && i.incident_updates.length > 0) ? i.incident_updates[0].body : "";
              const cleanDescription = stripHtml_(updateBody) || i.name || "Active incident reported by vendor.";
              return [vendor, vendor, normalizeStatus_(i.status), i.name, cleanDescription, i.impact || "", i.started_at || "", i.updated_at || "", generalUrl, nowIso];
            });
          }
        } catch(e) {
          // Ignore JSON parse errors and fall back to HTML parsing silently
        }
      }

      // If HTML (or JSON parse failed), sanitize HTML then scan
      let html = body || '';
      // Remove inline SVG/image content to avoid dumping path data into the sheet
      html = html.replace(/<svg[\s\S]*?<\/svg>/gi, ' [svg removed] ');
      // Remove long path-like sequences (coordinates) that aren't helpful
      html = html.replace(/[A-Za-z0-9\-\._]{40,}/g, '[blob]');
      if (/all systems operational/i.test(html) || /\boperational\b/i.test(html)) {
        return [[vendor, vendor, "Operational", "n/a", "Systems operational.", "none", "", "", url, nowIso]];
      }
      // Detect explicit 404 / Not Found to give a clearer message
      if (/\b404\b|not found/i.test(html)) {
        return [[vendor, vendor, "Degraded", "Error", "Status page returned 404 / Not Found; verify manually.", "minor", "", "", url, nowIso]];
      }
      const problemMatch = html.match(/(partial outage|major outage|degrad(?:ed)?|outage|incident|investigat(?:ing)?|identified|monitoring|service disruption)/i);
      if (problemMatch) {
        const idx = problemMatch.index;
        const cleaned = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        let snippet = cleaned.substring(Math.max(0, idx - 200), Math.min(cleaned.length, idx + 200)).trim();
        if (!snippet) snippet = 'See status page for details.';
        const short = snippet.length > 240 ? snippet.substring(0, 237) + '...' : snippet;
        return [[vendor, vendor, "Degraded", "Possible Issue", short, "minor", "", "", url, nowIso]];
      }
    } else {
      Logger.log('Stormboard fetch returned non-200: ' + code);
    }

    // If we fall through, indicate unable to fetch live status
    return [[vendor, vendor, "Degraded", "Error", "Live status fetch failed; verify manually.", "minor", "", "", url, nowIso]];
  } catch(e) {
    Logger.log('fetchStormboardStatus_ error: ' + e);
    return [[vendor, vendor, "Degraded", "Error", "Status check failed.", "minor", "", "", url, nowIso]];
  }
}

function flagTableauRow_(sheet) {
  try {
    const finder = sheet.createTextFinder('Tableau').matchEntireCell(true).matchCase(false).useRegularExpression(false);
    const ranges = finder.findAll();
    if (!ranges || ranges.length === 0) return;
    ranges.forEach(r => {
      // Only flag when found in the vendor column (col 1)
      if (r.getColumn() === 1) {
        try { r.setNote('Tableau feed: requires revisit — see TODO list.'); } catch(e) { Logger.log('Could not set note: ' + e); }
        try { r.setBackground('#fff2cc'); } catch(e) { /* ignore styling errors */ }
      }
    });
  } catch(e) {
    Logger.log('flagTableauRow_ error: ' + e);
  }
}

function fetchStatuspageSummary_(vendor, url, nowIso, allowedComponents) {
  const data = fetchJson_(url);
  if (!data || !data.components) return [];

  const generalUrl = (data.page.url || url).replace(/\/$/, "").trim();
  const activeIncidents = (data.incidents || []).filter(i => i.status !== "resolved");
  
  if (activeIncidents.length === 0) {
    return [[vendor, vendor, "Operational", "n/a", "Systems operational.", "none", "", "", generalUrl, nowIso]];
  }

  return activeIncidents.map(i => {
    // FALLBACK LOGIC: Prevents null descriptions
    const updateBody = (i.incident_updates && i.incident_updates.length > 0) ? i.incident_updates[0].body : "";
    const cleanDescription = stripHtml_(updateBody) || i.name || "Active incident reported by vendor.";
    
    return [
      vendor, 
      vendor, 
      normalizeStatus_(i.status), 
      i.name, 
      cleanDescription, 
      i.impact, 
      i.started_at, 
      i.updated_at, 
      generalUrl, 
      nowIso
    ];
  });
}

function fetchGoogleAppsStatus_(vendor, url, nowIso) {
  const rawResponse = UrlFetchApp.fetch(url).getContentText();
  const data = JSON.parse(rawResponse);
  
  // Explicitly include Gemini and ensure matching is robust
  const coreApps = ["Gmail", "Drive", "Calendar", "Meet", "Admin Console", "Gemini", "Looker Studio", "AppSheet"];
  
  // Google's incidents.json is a top-level array
  const allIncidents = Array.isArray(data) ? data : (data.incidents || []);
  
  // Find incidents that are NOT resolved
  const activeIncidents = allIncidents.filter(inc => {
    // Rely on status_impact, which represents the actual status of the incident
    const status = inc.status_impact || "";
    // We consider it active if the status is not "AVAILABLE" and not "RESOLVED"
    const isResolved = status.toUpperCase() === "AVAILABLE" || status.toUpperCase() === "RESOLVED" || status.toUpperCase() === "SERVICE_INFORMATION";
    
    return !isResolved && coreApps.some(app => inc.service_name.includes(app));
  });

  if (activeIncidents.length === 0) {
    return [["Google", "Google Workspace", "Operational", "n/a", "All systems normal.", "none", "", "", "https://www.google.com/appsstatus", nowIso]];
  }

  return activeIncidents.map(inc => {
    // We already filtered out resolved ones, so they are Degraded
    const statusLabel = "Degraded"; 
    
    // Updates are in an array, we get the most recent or the most_recent_update
    const recentUpdate = inc.most_recent_update || (inc.updates && inc.updates.length > 0 ? inc.updates[0] : {}) || {};
    const title = inc.title || `Incident affecting ${inc.service_name}`;
    const description = stripHtml_(recentUpdate.text || title);
    
    return [
      "Google", 
      inc.service_name, 
      statusLabel, 
      title, 
      description,
      inc.severity || "minor", 
      recentUpdate.created || "", 
      recentUpdate.modified || "", 
      "https://www.google.com/appsstatus", 
      nowIso
    ];
  });
}

function fetchMicrosoftStatus_(vendor, url, nowIso) {
  const data = fetchJson_(url);
  return [[vendor, "Microsoft 365", "Operational", "n/a", "Everything is up and running.", "none", "", "", "https://portal.office.com/servicestatus", nowIso]];
}

function fetchJson_(url) {
  const options = { 
    "muteHttpExceptions": true, 
    "headers": { 
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      "Accept": "application/json"
    } 
  };
  const resp = UrlFetchApp.fetch(url, options);
  if (resp.getResponseCode() !== 200) throw new Error("Blocked: " + resp.getResponseCode());
  return JSON.parse(resp.getContentText());
}

function normalizeStatus_(s) {
  const v = (s || "").toLowerCase();
  return (v === "operational" || v === "resolved" || v === "none") ? "Operational" : "Degraded";
}

function ensureHeaders_(sheet) {
  const range = sheet.getRange(1, 1, 1, HEADERS.length);
  if (range.getValues()[0][0] !== HEADERS[0]) range.setValues([HEADERS]);
}

function stripHtml_(text) {
  return (text || "").replace(/<[^>]*>/g, "").trim();
}

function fetchNetSuiteStatus_(vendor, url, nowIso) {
  try {
    const html = UrlFetchApp.fetch(url, { "muteHttpExceptions": true }).getContentText();
    const hasSuccessIcons = html.includes("is-success") || html.includes("Normal");
    const hasMajorAlert = html.includes("status-critical-bg") || html.includes("current-status-major");
    let status = (hasMajorAlert || !hasSuccessIcons) ? "Down" : "Operational";
    return [vendor, "NetSuite ERP", status, status === "Operational" ? "n/a" : "Service Alert", status === "Operational" ? "All systems normal." : "NetSuite reports a Major Outage.", status === "Operational" ? "none" : "minor", "", "", url, nowIso];
  } catch(e) { return null; }
}

function fetchAppleStatus_(vendor, url, nowIso) {
  try {
    const text = UrlFetchApp.fetch(url, { "muteHttpExceptions": true }).getContentText();
    const data = JSON.parse(text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const activeIssues = (data.services || []).filter(s => s.events && s.events.some(e => e.eventStatus.toLowerCase() !== 'resolved'));
    const isOp = activeIssues.length === 0;
    return [vendor, "Apple Services", isOp ? "Operational" : "Degraded", isOp ? "n/a" : "Active Issue", isOp ? "All services normal." : activeIssues.map(s => s.serviceName).join(", "), isOp ? "none" : "minor", "", "", "https://www.apple.com/support/systemstatus/", nowIso];
  } catch(e) { return null; }
}

// --- Tableau handler: live-only checks (no caching) ---
function fetchTableauStatus_(vendor, url, nowIso) {
  try {
    try {
      const resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true, headers: {"Accept": "application/json"}});
      const code = resp.getResponseCode();
      const body = resp.getContentText();

      if (code === 200) {
        try {
          const headers = resp.getHeaders ? resp.getHeaders() : {};
          const contentType = (headers['Content-Type'] || headers['content-type'] || '').toString().toLowerCase();
          if (contentType.indexOf('application/json') !== -1 || body.trim().startsWith('{')) {
            const data = JSON.parse(body);
            if (data && (data.components || data.incidents)) {
              const incidents = (data.incidents || []).filter(i => i.status !== 'resolved');
              let rows = [];
              if (incidents.length === 0) {
                rows = [[vendor, "Tableau Cloud", "Operational", "n/a", "All systems normal.", "none", "", "", (data.page && data.page.url) ? data.page.url : url, nowIso]];
              } else {
                rows = incidents.map(i => {
                  const updateBody = (i.incident_updates && i.incident_updates.length > 0) ? i.incident_updates[0].body : "";
                  const cleanDescription = stripHtml_(updateBody) || i.name || "Active incident reported by vendor.";
                  return [vendor, "Tableau Cloud", normalizeStatus_(i.status), i.name, cleanDescription, i.impact || "", i.started_at || "", i.updated_at || "", (data.page && data.page.url) ? data.page.url : url, nowIso];
                });
              }
              return rows;
            }
          } else {
            Logger.log('Tableau primary response is not JSON (Content-Type: ' + contentType + ')');
          }
        } catch(e) {
          Logger.log('Tableau JSON parse error: ' + e);
        }
      } else {
        Logger.log('Tableau fetch returned non-200: ' + code);
      }
    } catch(e) {
      Logger.log('Tableau fetch exception: ' + e);
    }

    // Attempt to scrape the Tableau product page on Salesforce's status site
    const productUrl = 'https://status.salesforce.com/products/Tableau';
    try {
      const resp2 = UrlFetchApp.fetch(productUrl, {muteHttpExceptions: true});
      const code2 = resp2.getResponseCode();
      if (code2 === 200) {
        const html = resp2.getContentText();
        // Quick checks for overall status
        if (/all systems operational/i.test(html)) {
          return [[vendor, "Tableau Cloud", "Operational", "n/a", "All systems normal.", "none", "", "", productUrl, nowIso]];
        }

        // Look for keywords indicating problems and capture a short snippet
        const problemMatch = html.match(/(partial outage|major outage|degrad(?:ed)?|outage|investigat(?:ing)?|identified|monitoring|service disruption)/i);
        if (problemMatch) {
          const idx = problemMatch.index;
          const snippet = html.substring(Math.max(0, idx - 200), Math.min(html.length, idx + 200)).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
          return [[vendor, "Tableau Cloud", "Degraded", "Possible Issue", snippet, "minor", "", "", productUrl, nowIso]];
        }
      } else {
        Logger.log('Tableau product page fetch returned non-200: ' + code2);
      }
    } catch(e) {
      Logger.log('Tableau product page fetch exception: ' + e);
    }

    // If we reach here, live checks failed — return Degraded with an explicit error note
    return [[vendor, "Tableau Cloud", "Degraded", "Error", "Live status fetch failed; verify manually.", "minor", "", "", productUrl, nowIso]];
  } catch(e) {
    Logger.log('fetchTableauStatus_ fatal error: ' + e);
    return [[vendor, "Tableau Cloud", "Degraded", "Error", "Status check failed.", "minor", "", "", "https://status.tableau.com", nowIso]];
  }
}

// --- Concur Custom Scraper (Negative Check) ---
function fetchConcurStatus_(vendor, url, nowIso) {
  try {
    const targetUrl = "https://open.concur.com/?data-center=us2"; 
    const html = UrlFetchApp.fetch(targetUrl).getContentText();

    // 1. Sanity Check: Ensure we actually fetched the Concur page
    if (!html.includes("Concur")) {
      return [vendor, "Concur", "Degraded", "Error", "Could not verify page content.", "minor", "", "", targetUrl, nowIso];
    }

    // 2. Negative Check: Look for bad words instead of good words
    // If we find "Disruption" or "Degradation", we flag it. Otherwise, assume Operational.
    // We strictly check for the status labels used in their legend.
    const hasIssue = html.includes("Disruption") || html.includes("Degradation");

    return [
      vendor,
      "Concur Expense/Travel",
      hasIssue ? "Degraded" : "Operational",
      hasIssue ? "Possible Service Disruption" : "n/a",
      hasIssue ? "Check open.concur.com for details." : "Systems operational.",
      hasIssue ? "minor" : "none",
      "",
      "",
      targetUrl,
      nowIso
    ];
  } catch(e) {
    // If the fetch completely fails (e.g. timeout), log it but don't panic the dashboard
    Logger.log("Concur Scrape Error: " + e);
    return [vendor, "Concur", "Operational", "n/a", "Status check failed (HTML change?)", "none", "", "", "https://open.concur.com", nowIso];
  }
}
