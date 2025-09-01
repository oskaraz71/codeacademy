const http = require("http");

const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Labas rytas! Čia mano pirmas Node.js serveris ");
});

server.listen(3000, () => {
    console.log("Serveris veikia: http://localhost:3000");
});
