import { timingSafeEqual, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { chmod, open, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { DatabaseSync } from "node:sqlite";

const root = path.dirname(fileURLToPath(import.meta.url));
const maxFileSize = 10 * 1024 * 1024;
const allowedTypes = new Map([
  [".pdf", { mime: "application/pdf", signature: (bytes) => bytes.subarray(0, 5).toString() === "%PDF-" }],
  [".jpg", { mime: "image/jpeg", signature: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff }],
  [".jpeg", { mime: "image/jpeg", signature: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff }],
  [".png", { mime: "image/png", signature: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) }],
]);
const requiredDocuments = [
  { type: "insurance", fileField: "insurance", expiryField: "insuranceExpiryDate", label: "Insurance" },
  { type: "safety_statement", fileField: "safetyStatement", expiryField: "safetyStatementExpiryDate", label: "Company safety statement" },
  { type: "rams", fileField: "rams", expiryField: "ramsExpiryDate", label: "RAMS" },
];
const allowedPermitTypes = new Set([
  "Hot work permit",
  "Confined space permit",
  "Work at height permit",
  "Other",
]);
const allowedContractorSites = new Set([
  "Tricel Weston",
  "Tricel Killarney",
  "Tricel Gloucester",
]);
const maxCrews = 10;
const maxCertificates = 10;
const crewUploadFields = Array.from({ length: maxCrews }, (_unused, index) => ({
  field: `crewName_${index}`,
}));
const certificateUploadFields = Array.from({ length: maxCertificates }, (_unused, index) => ({
  fileField: `certificate_${index}`,
  crewField: `certificateCrew_${index}`,
  nameField: `certificateName_${index}`,
  expiryField: `certificateExpiryDate_${index}`,
}));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function safeEqual(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function basicAuth(credentials) {
  return (req, res, next) => {
    const header = req.get("authorization") || "";
    const match = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
    if (match) {
      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0
        && safeEqual(decoded.slice(0, separator), credentials.username)
        && safeEqual(decoded.slice(separator + 1), credentials.password)) {
        return next();
      }
    }
    res.set("WWW-Authenticate", 'Basic realm="Tricel Safety", charset="UTF-8"');
    return res.status(401).json({ error: "Authentication required." });
  };
}

function validateText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(400, `${label} is required and must be ${maxLength} characters or fewer.`);
  }
  return value.trim();
}

function validateOptionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new HttpError(400, `${label} must be ${maxLength} characters or fewer.`);
  }
  return value.trim();
}

function validateEmail(value, label) {
  const email = validateText(value, label, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, `Enter a valid ${label.toLowerCase()}.`);
  }
  return email;
}

function contractorFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    site: row.site,
    trade: row.trade,
    project: row.project,
    status: row.status,
    approvalStatus: row.approval_status,
    approvedBy: row.approved_by,
    reviewComments: row.review_comments,
    createdAt: row.created_at,
  };
}

function documentFromRow(row) {
  return {
    id: row.id,
    contractorId: row.contractor_id,
    contractorName: row.contractor_name,
    projectOwnerName: row.project_owner_name,
    projectOwnerPhone: row.project_owner_phone,
    projectOwnerEmail: row.project_owner_email,
    submissionId: row.submission_id,
    type: row.type,
    jobName: row.job_name,
    crewName: row.crew_name,
    areaLocation: row.area_location,
    permitsRequired: row.permits_required,
    expiryDate: row.expiry_date,
    originalName: row.original_name,
    uploadedAt: row.uploaded_at,
    verificationStatus: row.verification_status,
    verifiedBy: row.verified_by,
    reviewComments: row.review_comments,
  };
}

function purchasingDocumentFromRow(row) {
  return {
    id: row.id,
    contractorId: row.contractor_id,
    contractorName: row.contractor_name,
    type: row.type,
    documentName: row.document_name,
    originalName: row.original_name,
    uploadedAt: row.uploaded_at,
  };
}

function purchasingReviewFromRow(row) {
  return {
    contractorId: row.contractor_id,
    contractorName: row.contractor_name,
    reviewerName: row.reviewer_name,
    approvalStatus: row.approval_status,
    financeEmail: row.finance_email,
    projectOwnerEmail: row.project_owner_email,
    comments: row.comments,
    updatedAt: row.updated_at,
  };
}

function financeReviewFromRow(row) {
  return {
    contractorId: row.contractor_id,
    contractorName: row.contractor_name,
    financeName: row.finance_name,
    healthSafetyEmail: row.health_safety_email,
    projectOwnerEmail: row.project_owner_email,
    approvalStatus: row.approval_status,
    comments: row.comments,
    updatedAt: row.updated_at,
  };
}

function inductionFromRow(row) {
  return {
    contractorId: row.contractor_id,
    contractorName: row.contractor_name,
    crewName: row.crew_name,
    healthSafetyOfficer: row.health_safety_officer || "",
    inductionCompleted: Boolean(row.induction_completed),
    inductionDate: row.induction_date || "",
    expiryDate: row.expiry_date || "",
    facilitiesWelfareExplained: Boolean(row.facilities_welfare_explained),
    fireAssemblyPointExplained: Boolean(row.fire_assembly_point_explained),
    updatedAt: row.updated_at || "",
  };
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function validateDateTime(value, label) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new HttpError(400, `Enter a valid ${label}.`);
  }
  return value;
}

async function verifyUploadedFile(file, label) {
  const fileHandle = await open(file.path, "r");
  const signature = Buffer.alloc(8);
  let bytesRead;
  try {
    ({ bytesRead } = await fileHandle.read(signature, 0, signature.length, 0));
  } finally {
    await fileHandle.close();
  }
  const fileType = allowedTypes.get(path.extname(file.originalname).toLowerCase());
  if (!fileType.signature(signature.subarray(0, bytesRead))) {
    throw new HttpError(400, `The ${label.toLowerCase()} file content does not match its file type.`);
  }
}

function refreshContractorStatuses(db) {
  const today = new Date().toISOString().slice(0, 10);
  const latestDocuments = new Map();
  const records = db.prepare(`
    SELECT contractor_id, type, job_name, crew_name, expiry_date
    FROM documents
    ORDER BY uploaded_at DESC, rowid DESC
  `).all();
  records.forEach((record) => {
    const requirement = record.type === "job_certification"
      ? `${record.type}:${record.crew_name}:${record.job_name}`
      : record.type;
    const key = `${record.contractor_id}:${requirement}`;
    if (!latestDocuments.has(key)) latestDocuments.set(key, record);
  });
  const updateStatus = db.prepare("UPDATE contractors SET status = ? WHERE id = ?");
  for (const { id } of db.prepare("SELECT id FROM contractors").all()) {
    const contractorDocuments = [...latestDocuments.values()].filter((record) => record.contractor_id === id);
    const baseComplete = requiredDocuments.every((document) => contractorDocuments.some((record) =>
      record.type === document.type && record.expiry_date >= today,
    ));
    const certificates = contractorDocuments.filter(({ type, crew_name }) => type === "job_certification" && crew_name);
    const certificatesComplete = certificates.length > 0 && certificates.every(({ expiry_date }) => expiry_date >= today);
    updateStatus.run(baseComplete && certificatesComplete ? "Complete" : "Pending", id);
  }
}

export function createApp({
  databasePath = path.join(process.env.DATA_DIRECTORY || path.join(root, "data"), "tricel.sqlite"),
  uploadDirectory = path.join(process.env.DATA_DIRECTORY || path.join(root, "data"), "uploads"),
  credentials = { username: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD },
} = {}) {
  if (!credentials?.username || !credentials?.password) {
    throw new Error("Set ADMIN_USER and ADMIN_PASSWORD before starting the server.");
  }

  const resolvedDatabasePath = path.resolve(databasePath);
  const resolvedUploadDirectory = path.resolve(uploadDirectory);
  const databaseDirectory = path.dirname(resolvedDatabasePath);
  mkdirSync(databaseDirectory, { recursive: true });
  mkdirSync(resolvedUploadDirectory, { recursive: true });
  chmodSync(databaseDirectory, 0o700);
  chmodSync(resolvedUploadDirectory, 0o700);
  const db = new DatabaseSync(resolvedDatabasePath);
  chmodSync(resolvedDatabasePath, 0o600);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS contractors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      site TEXT NOT NULL DEFAULT 'Unassigned',
      trade TEXT NOT NULL,
      project TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      approval_status TEXT NOT NULL DEFAULT 'Pending',
      approved_by TEXT NOT NULL DEFAULT '',
      review_comments TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      contractor_id TEXT NOT NULL REFERENCES contractors(id),
      type TEXT NOT NULL,
      submission_id TEXT,
      job_name TEXT,
      area_location TEXT NOT NULL DEFAULT '',
      project_owner_name TEXT NOT NULL DEFAULT '',
      project_owner_phone TEXT NOT NULL DEFAULT '',
      project_owner_email TEXT NOT NULL DEFAULT '',
      permits_required TEXT NOT NULL DEFAULT '',
      expiry_date TEXT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      verification_status TEXT NOT NULL DEFAULT 'Unverified',
      verified_by TEXT NOT NULL DEFAULT '',
      review_comments TEXT NOT NULL DEFAULT '',
      uploaded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permits (
      id TEXT PRIMARY KEY,
      contractor_id TEXT NOT NULL REFERENCES contractors(id),
      submission_id TEXT NOT NULL,
      permit_type TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      area_location TEXT NOT NULL,
      contact_name TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      issuer_name TEXT NOT NULL DEFAULT '',
      document_original_name TEXT NOT NULL DEFAULT '',
      document_stored_name TEXT NOT NULL DEFAULT '',
      document_mime_type TEXT NOT NULL DEFAULT '',
      document_size INTEGER NOT NULL DEFAULT 0,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purchasing_documents (
      id TEXT PRIMARY KEY,
      contractor_id TEXT NOT NULL REFERENCES contractors(id),
      type TEXT NOT NULL,
      document_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploaded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purchasing_template (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploaded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purchasing_reviews (
      contractor_id TEXT PRIMARY KEY REFERENCES contractors(id),
      reviewer_name TEXT NOT NULL,
      approval_status TEXT NOT NULL CHECK (approval_status IN ('Approved', 'Not approved')),
      finance_email TEXT NOT NULL DEFAULT '',
      project_owner_email TEXT NOT NULL DEFAULT '',
      comments TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS finance_reviews (
      contractor_id TEXT PRIMARY KEY REFERENCES contractors(id),
      finance_name TEXT NOT NULL,
      finance_email TEXT NOT NULL,
      approval_status TEXT NOT NULL CHECK (approval_status IN ('Pending', 'Approved', 'Not approved')),
      health_safety_email TEXT NOT NULL DEFAULT '',
      project_owner_email TEXT NOT NULL DEFAULT '',
      comments TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS induction_records (
      contractor_id TEXT NOT NULL REFERENCES contractors(id),
      crew_name TEXT NOT NULL,
      health_safety_officer TEXT NOT NULL DEFAULT '',
      induction_completed INTEGER NOT NULL DEFAULT 0,
      induction_date TEXT NOT NULL DEFAULT '',
      expiry_date TEXT NOT NULL DEFAULT '',
      facilities_welfare_explained INTEGER NOT NULL DEFAULT 0,
      fire_assembly_point_explained INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (contractor_id, crew_name)
    );
    DROP INDEX IF EXISTS contractors_email_unique;
    CREATE UNIQUE INDEX contractors_email_unique ON contractors(lower(email)) WHERE email <> '';
  `);
  const purchasingReviewColumns = new Set(db.prepare("PRAGMA table_info(purchasing_reviews)").all().map(({ name }) => name));
  const purchasingReviewMigrations = [
    ["finance_email", "TEXT NOT NULL DEFAULT ''"],
    ["project_owner_email", "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, definition] of purchasingReviewMigrations) {
    if (!purchasingReviewColumns.has(name)) {
      db.exec(`ALTER TABLE purchasing_reviews ADD COLUMN ${name} ${definition}`);
    }
  }
  const financeReviewColumns = new Set(db.prepare("PRAGMA table_info(finance_reviews)").all().map(({ name }) => name));
  const financeReviewMigrations = [
    ["health_safety_email", "TEXT NOT NULL DEFAULT ''"],
    ["project_owner_email", "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, definition] of financeReviewMigrations) {
    if (!financeReviewColumns.has(name)) {
      db.exec(`ALTER TABLE finance_reviews ADD COLUMN ${name} ${definition}`);
    }
  }
  const contractorColumns = new Set(db.prepare("PRAGMA table_info(contractors)").all().map(({ name }) => name));
  if (!contractorColumns.has("site")) {
    db.exec("ALTER TABLE contractors ADD COLUMN site TEXT NOT NULL DEFAULT 'Unassigned'");
  }
  if (!contractorColumns.has("approval_status")) {
    db.exec("ALTER TABLE contractors ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'Pending'");
  }
  if (!contractorColumns.has("approved_by")) {
    db.exec("ALTER TABLE contractors ADD COLUMN approved_by TEXT NOT NULL DEFAULT ''");
  }
  if (!contractorColumns.has("review_comments")) {
    db.exec("ALTER TABLE contractors ADD COLUMN review_comments TEXT NOT NULL DEFAULT ''");
  }
  const documentColumns = new Set(db.prepare("PRAGMA table_info(documents)").all().map(({ name }) => name));
  if (!documentColumns.has("area_location")) {
    db.exec("ALTER TABLE documents ADD COLUMN area_location TEXT NOT NULL DEFAULT ''");
  }
  if (!documentColumns.has("project_owner_name")) {
    db.exec("ALTER TABLE documents ADD COLUMN project_owner_name TEXT NOT NULL DEFAULT ''");
  }
  if (!documentColumns.has("project_owner_phone")) {
    db.exec("ALTER TABLE documents ADD COLUMN project_owner_phone TEXT NOT NULL DEFAULT ''");
  }
  if (!documentColumns.has("project_owner_email")) {
    db.exec("ALTER TABLE documents ADD COLUMN project_owner_email TEXT NOT NULL DEFAULT ''");
  }
  if (!documentColumns.has("permits_required")) {
    db.exec("ALTER TABLE documents ADD COLUMN permits_required TEXT NOT NULL DEFAULT ''");
  }
  if (!documentColumns.has("expiry_date")) {
    db.exec("ALTER TABLE documents ADD COLUMN expiry_date TEXT");
  }
  if (!documentColumns.has("crew_name")) {
    db.exec("ALTER TABLE documents ADD COLUMN crew_name TEXT");
  }
  if (!documentColumns.has("submission_id")) {
    db.exec("ALTER TABLE documents ADD COLUMN submission_id TEXT");
  }
  if (!documentColumns.has("verification_status")) {
    db.exec("ALTER TABLE documents ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'Unverified'");
  }
  if (!documentColumns.has("verified_by")) {
    db.exec("ALTER TABLE documents ADD COLUMN verified_by TEXT NOT NULL DEFAULT ''");
  }
  if (!documentColumns.has("review_comments")) {
    db.exec("ALTER TABLE documents ADD COLUMN review_comments TEXT NOT NULL DEFAULT ''");
  }
  const permitColumns = new Set(db.prepare("PRAGMA table_info(permits)").all().map(({ name }) => name));
  if (!permitColumns.has("contact_name")) {
    db.exec("ALTER TABLE permits ADD COLUMN contact_name TEXT NOT NULL DEFAULT ''");
  }
  if (!permitColumns.has("contact_email")) {
    db.exec("ALTER TABLE permits ADD COLUMN contact_email TEXT NOT NULL DEFAULT ''");
  }
  if (!permitColumns.has("issuer_name")) {
    db.exec("ALTER TABLE permits ADD COLUMN issuer_name TEXT NOT NULL DEFAULT ''");
  }
  if (!permitColumns.has("document_original_name")) {
    db.exec("ALTER TABLE permits ADD COLUMN document_original_name TEXT NOT NULL DEFAULT ''");
  }
  if (!permitColumns.has("document_stored_name")) {
    db.exec("ALTER TABLE permits ADD COLUMN document_stored_name TEXT NOT NULL DEFAULT ''");
  }
  if (!permitColumns.has("document_mime_type")) {
    db.exec("ALTER TABLE permits ADD COLUMN document_mime_type TEXT NOT NULL DEFAULT ''");
  }
  if (!permitColumns.has("document_size")) {
    db.exec("ALTER TABLE permits ADD COLUMN document_size INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("CREATE INDEX IF NOT EXISTS documents_contractor_idx ON documents(contractor_id, uploaded_at)");
  refreshContractorStatuses(db);

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    });
    next();
  });
  app.use(basicAuth(credentials));
  app.use(express.json({ limit: "32kb" }));

  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, resolvedUploadDirectory),
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  });
  const upload = multer({
    storage,
    limits: {
      fileSize: maxFileSize,
      files: requiredDocuments.length + maxCertificates,
      fields: 2 + 3 + requiredDocuments.length + maxCrews + maxCertificates * 3,
      fieldSize: 1024,
    },
    fileFilter: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      const allowed = allowedTypes.get(extension);
      if (!allowed || file.mimetype !== allowed.mime) {
        return callback(new HttpError(400, "Only PDF, JPG, and PNG documents are accepted."));
      }
      return callback(null, true);
    },
  });

  app.get("/api/contractors", (_req, res) => {
    refreshContractorStatuses(db);
    const records = db.prepare("SELECT * FROM contractors ORDER BY created_at DESC").all();
    res.json(records.map(contractorFromRow));
  });

  app.post("/api/contractors", (req, res, next) => {
    try {
      const name = validateText(req.body?.name, "Name", 80);
      const email = validateText(req.body?.email, "Email", 120);
      const site = validateText(req.body?.site, "Site location", 80);
      const trade = validateText(req.body?.trade, "Trade", 80);
      const project = validateText(req.body?.project, "Project / job", 120);
      if (!allowedContractorSites.has(site)) {
        throw new HttpError(400, "Select a valid site location.");
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new HttpError(400, "Enter a valid email address.");
      }
      const contractor = {
        id: randomUUID(),
        name,
        email,
        site,
        trade,
        project,
        status: "Pending",
        createdAt: new Date().toISOString(),
      };
      db.prepare(`
        INSERT INTO contractors (id, name, email, site, trade, project, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(contractor.id, name, email, site, trade, project, contractor.status, contractor.createdAt);
      res.status(201).json(contractor);
    } catch (error) {
      if (error.errcode === 2067 && error.message.includes("contractors_email_unique")) {
        return next(new HttpError(409, "A contractor with that email already exists."));
      }
      return next(error);
    }
  });

  app.patch("/api/contractors/:id/review", (req, res, next) => {
    try {
      const approvalStatus = req.body?.approvalStatus;
      if (!["Pending", "Approved"].includes(approvalStatus)) {
        throw new HttpError(400, "Select a valid contractor approval status.");
      }
      const approvedBy = validateOptionalText(req.body?.approvedBy, "Approver name", 80);
      if (approvalStatus === "Approved" && !approvedBy) {
        throw new HttpError(400, "Enter who approved this contractor.");
      }
      const comments = validateOptionalText(req.body?.reviewComments, "Contractor comments", 2000);
      if (!db.prepare("SELECT id FROM contractors WHERE id = ?").get(req.params.id)) {
        throw new HttpError(404, "Contractor not found.");
      }
      db.prepare(`
        UPDATE contractors
        SET approval_status = ?, approved_by = ?, review_comments = ?
        WHERE id = ?
      `).run(approvalStatus, approvalStatus === "Approved" ? approvedBy : "", comments, req.params.id);
      const record = db.prepare("SELECT * FROM contractors WHERE id = ?").get(req.params.id);
      res.json(contractorFromRow(record));
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/documents", (_req, res) => {
    const records = db.prepare(`
      SELECT documents.*, contractors.name AS contractor_name, documents.rowid AS sequence
      FROM documents
      JOIN contractors ON contractors.id = documents.contractor_id
      ORDER BY documents.uploaded_at DESC, documents.rowid DESC
    `).all();
    res.json(records.map(documentFromRow));
  });

  app.get("/api/purchasing/template", (_req, res) => {
    const template = db.prepare("SELECT original_name, uploaded_at FROM purchasing_template WHERE id = 1").get();
    res.json(template ? { originalName: template.original_name, uploadedAt: template.uploaded_at } : null);
  });

  app.post("/api/purchasing/template", upload.single("template"), async (req, res, next) => {
    const file = req.file;
    try {
      if (!file) throw new HttpError(400, "Upload a blank supply registration form.");
      await chmod(file.path, 0o600);
      await verifyUploadedFile(file, "Supply registration form");
      const previous = db.prepare("SELECT stored_name FROM purchasing_template WHERE id = 1").get();
      db.prepare(`
        INSERT INTO purchasing_template (id, original_name, stored_name, mime_type, size, uploaded_at)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          original_name = excluded.original_name,
          stored_name = excluded.stored_name,
          mime_type = excluded.mime_type,
          size = excluded.size,
          uploaded_at = excluded.uploaded_at
      `).run(
        path.basename(file.originalname).slice(0, 200),
        file.filename,
        file.mimetype,
        file.size,
        new Date().toISOString(),
      );
      if (previous) {
        try {
          await unlink(path.join(resolvedUploadDirectory, previous.stored_name));
        } catch (error) {
          if (error.code !== "ENOENT") return next(error);
        }
      }
      return res.status(201).json({ originalName: path.basename(file.originalname).slice(0, 200) });
    } catch (error) {
      if (file) {
        try {
          await unlink(file.path);
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") return next(cleanupError);
        }
      }
      return next(error);
    }
  });

  app.get("/api/purchasing/template/download", (_req, res, next) => {
    const template = db.prepare("SELECT stored_name, original_name FROM purchasing_template WHERE id = 1").get();
    if (!template) return next(new HttpError(404, "No supply registration form has been uploaded."));
    return res.download(
      path.join(resolvedUploadDirectory, template.stored_name),
      template.original_name,
    );
  });

  app.get("/api/purchasing/documents", (_req, res) => {
    const records = db.prepare(`
      SELECT purchasing_documents.*, contractors.name AS contractor_name
      FROM purchasing_documents
      JOIN contractors ON contractors.id = purchasing_documents.contractor_id
      ORDER BY purchasing_documents.uploaded_at DESC, purchasing_documents.rowid DESC
    `).all();
    res.json(records.map(purchasingDocumentFromRow));
  });

  app.post("/api/purchasing/documents", upload.single("file"), async (req, res, next) => {
    const file = req.file;
    try {
      if (!file) throw new HttpError(400, "Select a purchasing document to upload.");
      await chmod(file.path, 0o600);
      await verifyUploadedFile(file, "Purchasing document");
      const contractorId = validateText(req.body?.contractorId, "Contractor", 80);
      const type = req.body?.type;
      if (!["registration", "quotation", "other"].includes(type)) {
        throw new HttpError(400, "Select a valid purchasing document type.");
      }
      const documentName = validateText(req.body?.documentName, "Document name", 120);
      const contractor = db.prepare("SELECT id, name FROM contractors WHERE id = ?").get(contractorId);
      if (!contractor) throw new HttpError(404, "Select an existing contractor.");
      const document = {
        id: randomUUID(),
        contractorId: contractor.id,
        contractorName: contractor.name,
        type,
        documentName,
        originalName: path.basename(file.originalname).slice(0, 200),
        uploadedAt: new Date().toISOString(),
      };
      db.prepare(`
        INSERT INTO purchasing_documents (
          id, contractor_id, type, document_name, original_name, stored_name, mime_type, size, uploaded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        document.id,
        document.contractorId,
        document.type,
        document.documentName,
        document.originalName,
        file.filename,
        file.mimetype,
        file.size,
        document.uploadedAt,
      );
      return res.status(201).json(document);
    } catch (error) {
      if (file) {
        try {
          await unlink(file.path);
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") return next(cleanupError);
        }
      }
      return next(error);
    }
  });

  app.get("/api/purchasing/documents/:id/download", (req, res, next) => {
    const record = db.prepare(`
      SELECT stored_name, original_name FROM purchasing_documents WHERE id = ?
    `).get(req.params.id);
    if (!record) return next(new HttpError(404, "Purchasing document not found."));
    return res.download(path.join(resolvedUploadDirectory, record.stored_name), record.original_name);
  });

  app.get("/api/purchasing/reviews", (_req, res) => {
    const records = db.prepare(`
      SELECT purchasing_reviews.*, contractors.name AS contractor_name
      FROM purchasing_reviews
      JOIN contractors ON contractors.id = purchasing_reviews.contractor_id
      ORDER BY purchasing_reviews.updated_at DESC
    `).all();
    res.json(records.map(purchasingReviewFromRow));
  });

  app.put("/api/purchasing/reviews/:contractorId", (req, res, next) => {
    try {
      const { contractorId } = req.params;
      const approvalStatus = req.body?.approvalStatus;
      if (!["Approved", "Not approved"].includes(approvalStatus)) {
        throw new HttpError(400, "Select whether purchasing approved this contractor.");
      }
      const reviewerName = validateText(req.body?.reviewerName, "Purchasing reviewer name", 80);
      const financeEmail = approvalStatus === "Approved"
        ? validateEmail(req.body?.financeEmail, "Finance email address")
        : validateOptionalText(req.body?.financeEmail, "Finance email address", 120);
      if (financeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(financeEmail)) {
        throw new HttpError(400, "Enter a valid finance email address.");
      }
      const projectOwnerEmail = approvalStatus === "Not approved"
        ? validateEmail(req.body?.projectOwnerEmail, "Project Owner email address")
        : validateOptionalText(req.body?.projectOwnerEmail, "Project Owner email address", 120);
      if (projectOwnerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(projectOwnerEmail)) {
        throw new HttpError(400, "Enter a valid Project Owner email address.");
      }
      const comments = validateOptionalText(req.body?.comments, "Purchasing review comments", 2000);
      const contractor = db.prepare("SELECT id, name, project FROM contractors WHERE id = ?").get(contractorId);
      if (!contractor) {
        throw new HttpError(404, "Contractor not found.");
      }
      const updatedAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO purchasing_reviews (
          contractor_id, reviewer_name, approval_status, finance_email, project_owner_email, comments, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(contractor_id) DO UPDATE SET
          reviewer_name = excluded.reviewer_name,
          approval_status = excluded.approval_status,
          finance_email = excluded.finance_email,
          project_owner_email = excluded.project_owner_email,
          comments = excluded.comments,
          updated_at = excluded.updated_at
      `).run(contractorId, reviewerName, approvalStatus, financeEmail, projectOwnerEmail, comments, updatedAt);
      const record = db.prepare(`
        SELECT purchasing_reviews.*, contractors.name AS contractor_name
        FROM purchasing_reviews
        JOIN contractors ON contractors.id = purchasing_reviews.contractor_id
        WHERE purchasing_reviews.contractor_id = ?
      `).get(contractorId);
      return res.json(purchasingReviewFromRow(record));
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/finance/reviews", (_req, res) => {
    const records = db.prepare(`
      SELECT finance_reviews.*, contractors.name AS contractor_name
      FROM finance_reviews
      JOIN contractors ON contractors.id = finance_reviews.contractor_id
      ORDER BY finance_reviews.updated_at DESC
    `).all();
    res.json(records.map(financeReviewFromRow));
  });

  app.put("/api/finance/reviews/:contractorId", (req, res, next) => {
    try {
      const { contractorId } = req.params;
      const approvalStatus = req.body?.approvalStatus;
      if (!["Pending", "Approved", "Not approved"].includes(approvalStatus)) {
        throw new HttpError(400, "Select a valid finance insurance verification status.");
      }
      const financeName = validateText(req.body?.financeName, "Finance reviewer name", 80);
      const healthSafetyEmail = approvalStatus === "Approved"
        ? validateEmail(req.body?.healthSafetyEmail, "Health & Safety email address")
        : validateOptionalText(req.body?.healthSafetyEmail, "Health & Safety email address", 120);
      const projectOwnerEmail = approvalStatus === "Approved" || approvalStatus === "Not approved"
        ? validateEmail(req.body?.projectOwnerEmail, "Project Owner email address")
        : validateOptionalText(req.body?.projectOwnerEmail, "Project Owner email address", 120);
      for (const [email, label] of [
        [healthSafetyEmail, "Health & Safety"],
        [projectOwnerEmail, "Project Owner"],
      ]) {
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new HttpError(400, `Enter a valid ${label} email address.`);
        }
      }
      const comments = approvalStatus === "Not approved"
        ? validateText(req.body?.comments, "Finance rejection reason", 2000)
        : validateOptionalText(req.body?.comments, "Finance review comments", 2000);
      const contractor = db.prepare("SELECT id, name, project FROM contractors WHERE id = ?").get(contractorId);
      if (!contractor) {
        throw new HttpError(404, "Contractor not found.");
      }
      const purchasingReview = db.prepare(`
        SELECT finance_email FROM purchasing_reviews WHERE contractor_id = ?
      `).get(contractorId);
      const financeEmail = purchasingReview?.finance_email || "";
      const updatedAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO finance_reviews (
          contractor_id, finance_name, finance_email, approval_status,
          health_safety_email, project_owner_email, comments, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(contractor_id) DO UPDATE SET
          finance_name = excluded.finance_name,
          finance_email = excluded.finance_email,
          approval_status = excluded.approval_status,
          health_safety_email = excluded.health_safety_email,
          project_owner_email = excluded.project_owner_email,
          comments = excluded.comments,
          updated_at = excluded.updated_at
      `).run(
        contractorId, financeName, financeEmail, approvalStatus,
        healthSafetyEmail, projectOwnerEmail, comments, updatedAt,
      );
      const record = db.prepare(`
        SELECT finance_reviews.*, contractors.name AS contractor_name
        FROM finance_reviews
        JOIN contractors ON contractors.id = finance_reviews.contractor_id
        WHERE finance_reviews.contractor_id = ?
      `).get(contractorId);
      return res.json(financeReviewFromRow(record));
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/inductions", (_req, res) => {
    const records = db.prepare(`
      SELECT
        contractors.id AS contractor_id,
        contractors.name AS contractor_name,
        crew.crew_name,
        induction_records.health_safety_officer,
        induction_records.induction_completed,
        induction_records.induction_date,
        induction_records.expiry_date,
        induction_records.facilities_welfare_explained,
        induction_records.fire_assembly_point_explained,
        induction_records.updated_at
      FROM contractors
      JOIN (
        SELECT contractor_id, MIN(trim(crew_name)) AS crew_name
        FROM documents
        WHERE type = 'job_certification' AND trim(COALESCE(crew_name, '')) <> ''
        GROUP BY contractor_id, lower(trim(crew_name))
      ) AS crew ON crew.contractor_id = contractors.id
      LEFT JOIN induction_records
        ON induction_records.contractor_id = contractors.id
        AND lower(induction_records.crew_name) = lower(crew.crew_name)
      ORDER BY contractors.name, crew.crew_name
    `).all();
    res.json(records.map(inductionFromRow));
  });

  app.put("/api/inductions/:contractorId", (req, res, next) => {
    try {
      const { contractorId } = req.params;
      const contractor = db.prepare("SELECT id, name FROM contractors WHERE id = ?").get(contractorId);
      if (!contractor) throw new HttpError(404, "Contractor not found.");
      const crewName = validateText(req.body?.crewName, "Crew member", 80);
      const rosterMember = db.prepare(`
        SELECT MIN(trim(crew_name)) AS crew_name
        FROM documents
        WHERE contractor_id = ? AND type = 'job_certification'
          AND trim(COALESCE(crew_name, '')) <> ''
        GROUP BY lower(trim(crew_name))
        HAVING lower(trim(crew_name)) = lower(?)
      `).get(contractorId, crewName);
      if (!rosterMember) {
        throw new HttpError(400, "Select a crew member listed for this contractor.");
      }
      const inductionCompleted = req.body?.inductionCompleted;
      const facilitiesWelfareExplained = req.body?.facilitiesWelfareExplained;
      const fireAssemblyPointExplained = req.body?.fireAssemblyPointExplained;
      if ([inductionCompleted, facilitiesWelfareExplained, fireAssemblyPointExplained]
        .some((answer) => typeof answer !== "boolean")) {
        throw new HttpError(400, "Answer each induction checklist question.");
      }
      const healthSafetyOfficer = inductionCompleted
        ? validateText(req.body?.healthSafetyOfficer, "Health & Safety officer name", 80)
        : validateOptionalText(req.body?.healthSafetyOfficer, "Health & Safety officer name", 80);
      const inductionDate = inductionCompleted
        ? validateText(req.body?.inductionDate, "Induction date", 10)
        : "";
      const expiryDate = inductionCompleted
        ? validateText(req.body?.expiryDate, "Induction expiry date", 10)
        : "";
      if (inductionCompleted && (!isValidDate(inductionDate) || !isValidDate(expiryDate))) {
        throw new HttpError(400, "Enter valid induction and expiry dates.");
      }
      if (inductionCompleted && expiryDate < inductionDate) {
        throw new HttpError(400, "Induction expiry date must be on or after the induction date.");
      }
      const updatedAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO induction_records (
          contractor_id, crew_name, health_safety_officer, induction_completed,
          induction_date, expiry_date, facilities_welfare_explained,
          fire_assembly_point_explained, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(contractor_id, crew_name) DO UPDATE SET
          health_safety_officer = excluded.health_safety_officer,
          induction_completed = excluded.induction_completed,
          induction_date = excluded.induction_date,
          expiry_date = excluded.expiry_date,
          facilities_welfare_explained = excluded.facilities_welfare_explained,
          fire_assembly_point_explained = excluded.fire_assembly_point_explained,
          updated_at = excluded.updated_at
      `).run(
        contractorId, rosterMember.crew_name, healthSafetyOfficer, Number(inductionCompleted),
        inductionDate, expiryDate, Number(facilitiesWelfareExplained),
        Number(fireAssemblyPointExplained), updatedAt,
      );
      const record = db.prepare(`
        SELECT
          contractors.id AS contractor_id,
          contractors.name AS contractor_name,
          induction_records.crew_name,
          induction_records.health_safety_officer,
          induction_records.induction_completed,
          induction_records.induction_date,
          induction_records.expiry_date,
          induction_records.facilities_welfare_explained,
          induction_records.fire_assembly_point_explained,
          induction_records.updated_at
        FROM induction_records
        JOIN contractors ON contractors.id = induction_records.contractor_id
        WHERE induction_records.contractor_id = ? AND induction_records.crew_name = ?
      `).get(contractorId, rosterMember.crew_name);
      return res.json(inductionFromRow(record));
    } catch (error) {
      return next(error);
    }
  });

  app.patch("/api/documents/:id/review", (req, res, next) => {
    try {
      const verificationStatus = req.body?.verificationStatus;
      if (!["Unverified", "Verified"].includes(verificationStatus)) {
        throw new HttpError(400, "Select a valid document verification status.");
      }
      const verifiedBy = validateOptionalText(req.body?.verifiedBy, "Verifier name", 80);
      if (verificationStatus === "Verified" && !verifiedBy) {
        throw new HttpError(400, "Enter who verified this document.");
      }
      const comments = validateOptionalText(req.body?.reviewComments, "Document comments", 2000);
      if (!db.prepare("SELECT id FROM documents WHERE id = ?").get(req.params.id)) {
        throw new HttpError(404, "Document not found.");
      }
      db.prepare(`
        UPDATE documents
        SET verification_status = ?, verified_by = ?, review_comments = ?
        WHERE id = ?
      `).run(verificationStatus, verificationStatus === "Verified" ? verifiedBy : "", comments, req.params.id);
      const record = db.prepare(`
        SELECT documents.*, contractors.name AS contractor_name
        FROM documents
        JOIN contractors ON contractors.id = documents.contractor_id
        WHERE documents.id = ?
      `).get(req.params.id);
      res.json(documentFromRow(record));
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/permits", (_req, res) => {
    const records = db.prepare(`
      SELECT permits.*, contractors.name AS contractor_name
      FROM permits
      JOIN contractors ON contractors.id = permits.contractor_id
      ORDER BY starts_at ASC, created_at DESC
    `).all();
    res.json(records.map((record) => ({
      id: record.id,
      contractorId: record.contractor_id,
      contractorName: record.contractor_name,
      submissionId: record.submission_id,
      type: record.permit_type,
      details: record.details,
      areaLocation: record.area_location,
      contactName: record.contact_name,
      contactEmail: record.contact_email,
      issuerName: record.issuer_name,
      documentName: record.document_original_name,
      startAt: record.starts_at,
      endAt: record.ends_at,
    })));
  });

  app.post("/api/permits", upload.single("permitDocument"), async (req, res, next) => {
    let transactionStarted = false;
    let filePersisted = false;
    try {
      if (req.file) {
        await chmod(req.file.path, 0o600);
        await verifyUploadedFile(req.file, "Permit document");
      }
      const contractorName = validateText(req.body?.contractorName, "Contractor name", 80);
      const areaLocation = validateText(req.body?.areaLocation, "Area / location", 120);
      const submittedTypes = req.body?.permitTypes;
      const selectedTypes = Array.isArray(submittedTypes)
        ? submittedTypes
        : submittedTypes ? [submittedTypes] : [];
      if (!selectedTypes.length || selectedTypes.some((type) => !allowedPermitTypes.has(type))) {
        throw new HttpError(400, "Select at least one valid permit type.");
      }
      const uniqueTypes = [...new Set(selectedTypes)];
      const otherDetails = uniqueTypes.includes("Other")
        ? validateText(req.body?.permitOther, "Other permit details", 400)
        : "";
      if (!uniqueTypes.includes("Other") && req.body?.permitOther) {
        throw new HttpError(400, "Select Other before entering other permit details.");
      }
      const permitRecords = uniqueTypes.map((type) => {
        const index = [...allowedPermitTypes].indexOf(type);
        const startAt = validateDateTime(req.body?.[`permitStart_${index}`], `${type.toLowerCase()} start date and time`);
        const endAt = validateDateTime(req.body?.[`permitEnd_${index}`], `${type.toLowerCase()} end date and time`);
        if (Date.parse(endAt) <= Date.parse(startAt)) {
          throw new HttpError(400, `${type} end date and time must be after its start date and time.`);
        }
        const contactName = type === "Hot work permit"
          ? validateText(req.body?.[`permitContactName_${index}`], "Hot work person in charge name", 80)
          : "";
        const contactEmail = type === "Hot work permit"
          ? validateText(req.body?.[`permitContactEmail_${index}`], "Hot work person in charge email address", 120)
          : "";
        if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
          throw new HttpError(400, "Enter a valid hot work person in charge email address.");
        }
        const issuerName = type === "Hot work permit"
          ? validateText(req.body?.[`permitIssuerName_${index}`], "Health & Safety issuer name", 80)
          : "";
        return {
          type,
          details: type === "Other" ? otherDetails : "",
          contactName,
          contactEmail,
          issuerName,
          startAt,
          endAt,
        };
      });

      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const existingContractor = db.prepare(`
        SELECT id, name FROM contractors
        WHERE lower(name) = lower(?)
        ORDER BY created_at DESC LIMIT 1
      `).get(contractorName);
      const contractor = existingContractor || {
        id: randomUUID(),
        name: contractorName,
      };
      if (!existingContractor) {
        db.prepare(`
          INSERT INTO contractors (id, name, email, trade, project, status, created_at)
          VALUES (?, ?, '', 'Not specified', ?, 'Pending', ?)
        `).run(contractor.id, contractor.name, areaLocation, new Date().toISOString());
      }
      const submissionId = randomUUID();
      const createdAt = new Date().toISOString();
      const insertPermit = db.prepare(`
        INSERT INTO permits (id, contractor_id, submission_id, permit_type, details, area_location, contact_name, contact_email, issuer_name, document_original_name, document_stored_name, document_mime_type, document_size, starts_at, ends_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const records = permitRecords.map((permit) => {
        const record = {
          id: randomUUID(),
          contractorId: contractor.id,
          contractorName: contractor.name,
          submissionId,
          type: permit.type,
          details: permit.details,
          areaLocation,
          contactName: permit.contactName,
          contactEmail: permit.contactEmail,
          issuerName: permit.issuerName,
          documentName: req.file ? path.basename(req.file.originalname).slice(0, 200) : "",
          startAt: permit.startAt,
          endAt: permit.endAt,
        };
        insertPermit.run(
          record.id, record.contractorId, record.submissionId, record.type, record.details, record.areaLocation,
          record.contactName, record.contactEmail, record.issuerName, record.documentName,
          req.file?.filename || "", req.file?.mimetype || "", req.file?.size || 0,
          record.startAt, record.endAt, createdAt,
        );
        return record;
      });
      db.exec("COMMIT");
      transactionStarted = false;
      filePersisted = Boolean(req.file);
      return res.status(201).json({ permits: records });
    } catch (error) {
      if (transactionStarted) db.exec("ROLLBACK");
      if (req.file && !filePersisted) {
        try {
          await unlink(req.file.path);
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") return next(cleanupError);
        }
      }
      return next(error);
    }
  });

  const documentUploadFields = [
    ...requiredDocuments.map(({ fileField }) => ({ name: fileField, maxCount: 1 })),
    ...crewUploadFields.map(({ field }) => ({ name: field, maxCount: 1 })),
    ...certificateUploadFields.map(({ fileField }) => ({ name: fileField, maxCount: 1 })),
  ];
  app.post("/api/documents", upload.fields(documentUploadFields), async (req, res, next) => {
    const uploadedFiles = Object.values(req.files || {}).flat();
    const storedPaths = uploadedFiles.map((file) => file.path);
    let transactionStarted = false;
    try {
      if (uploadedFiles.length < requiredDocuments.length + 1) {
        throw new HttpError(400, "Upload insurance, the company safety statement, RAMS, and at least one certification.");
      }
      for (const storedPath of storedPaths) await chmod(storedPath, 0o600);
      const contractorName = validateText(req.body?.contractorName, "Contractor name", 80);
      const areaLocation = validateText(req.body?.areaLocation, "Area / location", 120);
      const trade = validateText(req.body?.trade, "Trade name", 80);
      const site = validateText(req.body?.site, "Site location", 80);
      if (!allowedContractorSites.has(site)) {
        throw new HttpError(400, "Select a valid site location.");
      }
      const projectOwnerName = validateText(req.body?.projectOwnerName, "Project owner name", 80);
      const projectOwnerPhone = validateText(req.body?.projectOwnerPhone, "Project owner contact phone number", 30);
      const projectOwnerEmail = validateText(req.body?.projectOwnerEmail, "Project owner email address", 120);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(projectOwnerEmail)) {
        throw new HttpError(400, "Enter a valid project owner email address.");
      }
      const crews = new Map();
      crewUploadFields.forEach(({ field }, index) => {
        const crewName = req.body?.[field];
        if (crewName) crews.set(String(index), validateText(crewName, "Crew name", 80));
      });
      if (!crews.size) throw new HttpError(400, "Add at least one crew and its certification.");

      const uploadedDocuments = [];
      for (const definition of requiredDocuments) {
        const file = req.files?.[definition.fileField]?.[0];
        if (!file) throw new HttpError(400, `Upload the required ${definition.label} document.`);
        const expiryDate = validateText(req.body?.[definition.expiryField], `${definition.label} expiry date`, 10);
        if (!isValidDate(expiryDate)) throw new HttpError(400, `Enter a valid ${definition.label.toLowerCase()} expiry date.`);
        await verifyUploadedFile(file, definition.label);
        uploadedDocuments.push({ type: definition.type, label: definition.label, file, expiryDate, jobName: null });
      }

      for (const slot of certificateUploadFields) {
        const file = req.files?.[slot.fileField]?.[0];
        const crewIndex = req.body?.[slot.crewField];
        const nameValue = req.body?.[slot.nameField];
        const expiryValue = req.body?.[slot.expiryField];
        if (!file) {
          if (crewIndex || nameValue || expiryValue) {
            throw new HttpError(400, "Each crew certification needs a name, expiry date, and uploaded file.");
          }
          continue;
        }
        if (!crews.has(crewIndex)) throw new HttpError(400, "Assign each certification to a crew.");
        const jobName = validateText(nameValue, "Certification name", 120);
        const expiryDate = validateText(expiryValue, `${jobName} expiry date`, 10);
        if (!isValidDate(expiryDate)) throw new HttpError(400, `Enter a valid ${jobName.toLowerCase()} expiry date.`);
        await verifyUploadedFile(file, jobName);
        uploadedDocuments.push({
          type: "job_certification",
          label: jobName,
          file,
          expiryDate,
          crewName: crews.get(crewIndex),
          crewIndex,
          jobName,
        });
      }
      const crewsWithCertificates = new Set(uploadedDocuments
        .filter(({ type }) => type === "job_certification")
        .map(({ crewIndex }) => crewIndex));
      if ([...crews.keys()].some((crewIndex) => !crewsWithCertificates.has(crewIndex))) {
        throw new HttpError(400, "Add at least one certification for each crew.");
      }

      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const submissionId = randomUUID();
      let contractor = db.prepare(`
        SELECT id, name FROM contractors
        WHERE lower(name) = lower(?)
        ORDER BY created_at DESC LIMIT 1
      `).get(contractorName);
      if (!contractor) {
        contractor = {
          id: randomUUID(),
          name: contractorName,
        };
        db.prepare(`
          INSERT INTO contractors (id, name, email, site, trade, project, status, created_at)
          VALUES (?, ?, '', ?, ?, ?, 'Pending', ?)
        `).run(contractor.id, contractor.name, site, trade, areaLocation, new Date().toISOString());
      } else {
        db.prepare("UPDATE contractors SET site = ?, trade = ? WHERE id = ?")
          .run(site, trade, contractor.id);
      }

      const insertDocument = db.prepare(`
        INSERT INTO documents (id, contractor_id, submission_id, type, job_name, crew_name, area_location, project_owner_name, project_owner_phone, project_owner_email, permits_required, expiry_date, original_name, stored_name, mime_type, size, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const uploadedAt = Date.now();
      const records = uploadedDocuments.map(({ type, file, expiryDate, jobName, crewName }, index) => {
        const record = {
          id: randomUUID(),
          contractorId: contractor.id,
          contractorName: contractor.name,
          submissionId,
          type,
          jobName,
          crewName: crewName || null,
          areaLocation,
          projectOwnerName,
          projectOwnerPhone,
          projectOwnerEmail,
          permitsRequired: "",
          expiryDate,
          originalName: path.basename(file.originalname).slice(0, 200),
          uploadedAt: new Date(uploadedAt + index).toISOString(),
        };
        insertDocument.run(
          record.id, record.contractorId, record.submissionId, record.type, record.jobName, record.crewName,
          record.areaLocation, record.projectOwnerName, record.projectOwnerPhone, record.projectOwnerEmail,
          record.permitsRequired, record.expiryDate, record.originalName, file.filename,
          file.mimetype, file.size, record.uploadedAt,
        );
        return record;
      });
      refreshContractorStatuses(db);
      db.exec("COMMIT");
      transactionStarted = false;
      res.status(201).json({ documents: records });
    } catch (error) {
      if (transactionStarted) db.exec("ROLLBACK");
      for (const storedPath of storedPaths) {
        try {
          await unlink(storedPath);
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") return next(cleanupError);
        }
      }
      if (error.code === "ERR_SQLITE_CONSTRAINT_FOREIGNKEY") {
        return next(new HttpError(404, "Contractor not found."));
      }
      return next(error);
    }
  });

  app.get("/api/documents/:id/download", (req, res, next) => {
    const record = db.prepare("SELECT stored_name, original_name FROM documents WHERE id = ?").get(req.params.id);
    if (!record) return next(new HttpError(404, "Document not found."));
    return res.download(path.join(resolvedUploadDirectory, record.stored_name), record.original_name);
  });

  app.get("/api/permits/:id/document", (req, res, next) => {
    const record = db.prepare(`
      SELECT document_stored_name, document_original_name
      FROM permits WHERE id = ?
    `).get(req.params.id);
    if (!record || !record.document_stored_name) return next(new HttpError(404, "Permit document not found."));
    return res.download(
      path.join(resolvedUploadDirectory, record.document_stored_name),
      record.document_original_name,
    );
  });

  app.get("/", (_req, res) => res.sendFile(path.join(root, "index.html")));
  app.get("/index.html", (_req, res) => res.sendFile(path.join(root, "index.html")));
  app.get("/styles.css", (_req, res) => res.sendFile(path.join(root, "styles.css")));
  app.get("/app.js", (_req, res) => res.sendFile(path.join(root, "app.js")));
  app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));
  app.use((_req, res) => res.status(404).send("Not found."));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE"
        ? "File must be 10 MB or smaller."
        : "Upload contains too many files or form fields.";
      return res.status(400).json({ error: message });
    }
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    console.error(error);
    return res.status(500).json({ error: "The server could not complete the request." });
  });

  app.locals.database = db;
  app.locals.directories = { databaseDirectory, uploadDirectory: resolvedUploadDirectory };
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = createApp();
    const port = Number(process.env.PORT || 3000);
    app.listen(port, "0.0.0.0", () => {
      console.log(`Tricel safety workspace listening on port ${port}.`);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
