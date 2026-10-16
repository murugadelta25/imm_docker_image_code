from fastapi import WebSocket
from typing import List

class ConnectionManager:
    def __init__(self):
        self.active: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        self.active.remove(ws)

    async def broadcast(self, message: dict):
        import json
        for ws in self.active:
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                pass

manager = ConnectionManager()
