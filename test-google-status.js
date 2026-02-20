const https = require('https');
https.get("https://www.google.com/appsstatus/dashboard/incidents.json", (res) => {
  let body = "";
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => {
    const data = JSON.parse(body);
    const statuses = new Set();
    const mostRecentStatuses = new Set();
    data.forEach(inc => {
      statuses.add(inc.status_impact);
      if (inc.most_recent_update) mostRecentStatuses.add(inc.most_recent_update.status);
    });
    console.log("status_impact:", Array.from(statuses));
    console.log("most_recent_update.status:", Array.from(mostRecentStatuses));
  });
});
