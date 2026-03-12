const http = require('http');
const fs = require('fs');
const path = require('path');

const dir = '/Users/reba.pickeral/Downloads/mcqm-dashboard-v2/public';

http.createServer((req, res) => {
  const filePath = path.join(dir, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Error: ' + err.message);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(8889, () => {
  console.log('Server running on http://localhost:8889');
});
