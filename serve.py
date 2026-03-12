import http.server
import socketserver
import os

os.chdir('/Users/reba.pickeral/Downloads/cx-workbench')

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory='/Users/reba.pickeral/Downloads/cx-workbench', **kwargs)

with socketserver.TCPServer(("", 8889), Handler) as httpd:
    print("Server running on http://localhost:8889")
    httpd.serve_forever()
