from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .database import Base, engine
from .routers import rooms, sessions, staffs, assignments, venue_maps, export

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Conference Scheduler API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(rooms.router)
app.include_router(sessions.router)
app.include_router(staffs.router)
app.include_router(assignments.router)
app.include_router(venue_maps.router)
app.include_router(export.router)

app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")
