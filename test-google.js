const https = require('https');

function stripHtml_(text) {
  return (text || "").replace(/<[^>]*>/g, "").trim();
}

https.get("https://www.google.com/appsstatus/dashboard/incidents.json", function(res) {
  let body = "";
  res.on("data", function(chunk) { body += chunk; });
  res.on("end", function() {
    const data = JSON.parse(body);
    const nowIso = new Date().toISOString();
    const coreApps = ["Gmail", "Drive", "Calendar", "Meet", "Admin Console", "Gemini", "Looker Studio", "AppSheet"];
    
    const allIncidents = Array.isArray(data) ? data : (data.incidents || []);
    
    const activeIncidents = allIncidents.filter(function(inc) {
      const status = inc.status_impact || "";
      const isResolved = status.toUpperCase() === "AVAILABLE" || status.toUpperCase() === "RESOLVED" || status.toUpperCase() === "SERVICE_INFORMATION";
      return !isResolved && coreApps.some(function(app) { return inc.service_name.includes(app); });
    });

    if (activeIncidents.length === 0) {
      console.log(JSON.stringify([["Google", "Google Workspace", "Operational", "n/a", "All systems normal.", "none", "", "", "https://www.google.com/appsstatus", nowIso]]));
    } else {
      console.log(JSON.stringify(activeIncidents.map(function(inc) {
        const statusLabel = "Degraded"; 
        const recentUpdate = inc.most_recent_update || (inc.updates && inc.updates.length > 0 ? inc.updates[0] : {}) || {};
        const title = inc.title || "Incident affecting " + inc.service_name;
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
      })));
    }
  });
});
