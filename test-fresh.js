const https = require('https');

https.get("https://status.freshworks.com", res => {
  let body = "";
  res.on('data', d => body += d);
  res.on('end', () => {
    // Look for status endpoints in the raw HTML payload
    const matches = body.match(/https:\/\/[^"'\s]+\.json/g);
    if (matches) {
        console.log("Found JSON endpoints:", matches);
    } else {
        console.log("No JSON endpoints found explicitly in HTML.");
        console.log("Snippet:", body.slice(0, 500));
        
        // Let's also look for script tags that might contain the data
        const scriptMatches = body.match(/<script.*?src=["'](.*?)["']/g);
        console.log("Scripts:", scriptMatches);
    }
  });
});
