# Tricel Safety Workspace

The workspace includes a self-hosted Node.js API. It stores contractor records in
SQLite and submitted documents in a private local uploads directory; GitHub Pages
cannot run this backend or securely store uploads.

## Run locally or self-host

Requirements: Node.js 22.13 or newer.

```sh
npm install
ADMIN_USER=tricel-admin ADMIN_PASSWORD='use-a-long-unique-password' npm start
```

Open `http://localhost:3000`. The app and its API use HTTP Basic authentication
with the configured admin credentials. Set `ADMIN_USER`, `ADMIN_PASSWORD`, and
optionally `PORT` in the hosting environment; do not commit credentials. Put the
service behind HTTPS before exposing it outside a trusted local network.

The default `data/` directory contains `tricel.sqlite` and uploaded files. The
server applies restrictive local permissions to this storage. Back up this
directory securely; it is git-ignored.

## Deploy on Render

The repository includes a Render Blueprint in `render.yaml`. Push the repository
to GitHub, create a Blueprint in Render from that repository, and enter secure
values for `ADMIN_USER` and `ADMIN_PASSWORD` when prompted. Render builds and
starts the Node.js service and provides its HTTPS URL.

The Blueprint uses a paid Starter web service with a 1 GB persistent disk
mounted at `/var/data`. The disk stores both the SQLite database and uploaded
documents so they persist across deploys. Do not remove the disk or change
`DATA_DIRECTORY` without first backing up its contents.

## Document submissions

Each dashboard submission requires separate insurance, company safety statement,
and RAMS files, plus at least one crew member with a job-specific certification.
Each crew member can have multiple certifications, each with its own name,
uploaded file, and required expiry date. Up to 10 crew members and 10
certifications can be included in one submission. The contractor stays pending
until the latest base documents and every named crew certification are current;
expired items must be replaced. Submissions also require a contractor name and
area / location, plus a trade name and site location (Tricel Weston, Tricel
Killarney, or Tricel Gloucester). These contractor details appear on the
dashboard; submitting for an existing contractor updates their trade and site.
Typing a contractor not already on the roster creates a contractor record.
Document submissions are separate from permit submissions.
Each document submission also requires a project owner name, contact
phone number, and valid email address; these details are stored with and shown
alongside the submitted documents. Items expired or due within 30 days are
flagged. A separate permit submission must select at least one permit:
Hot work, Confined space, Work at height, or Other (with a required description).
Each selected permit requires a start and end date/time. Hot work permits also
require the person in charge's name and email address, plus the Health & Safety
issuer's name. The dashboard's Live
permits panel shows currently active permits and upcoming permits, with times
displayed in the viewer's local time zone.

## Purchasing requirements

Upload or replace the blank supply registration form for project owners to
download and send to suppliers. Select an existing contractor to view their
profile details and download submitted insurance copies. Upload completed supply
registration forms, quotations with a name or reference, and other supplier
documents with a document name; add multiple supplier documents as needed. Each
file is stored against the selected contractor. The purchasing team can record
a named reviewer, an approved / not-approved decision, and comments for each
contractor. A separate finance insurance verification can be assigned to a
named reviewer with an email address, tracked as pending / approved / not
approved, and saved with comments. The email action opens a notification draft
in the user's configured mail client.

Uploads accept PDF, JPG, and PNG files up to 10 MB, and the server checks the
file signature before storing them. Downloads and API endpoints require the
same admin authentication.

Run the API tests with `npm test`.