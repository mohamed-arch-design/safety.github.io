import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createApp } from "../server.js";

const activeFixtures = [];
const credentials = { username: "test-admin", password: "test-password" };
const requiredUploads = [
  { field: "insurance", expiry: "insuranceExpiryDate", type: "insurance", name: "insurance.pdf" },
  { field: "safetyStatement", expiry: "safetyStatementExpiryDate", type: "safety_statement", name: "safety-statement.pdf" },
  { field: "rams", expiry: "ramsExpiryDate", type: "rams", name: "rams.pdf" },
];

function documentBundle({
  expiryOverrides = {},
  site = "Tricel Weston",
  trade = "Electrical",
  certificates = [
    { crewName: "Crew Alpha", name: "Working at height", expiryDate: "2030-06-15" },
    { crewName: "Crew Alpha", name: "Confined space entry", expiryDate: "2031-02-03" },
    { crewName: "Crew Beta", name: "Working at height", expiryDate: "2032-03-04" },
  ],
  invalidFile,
} = {}) {
  const form = new FormData();
  form.set("contractorName", "Alex Morgan");
  form.set("areaLocation", "Plant room");
  form.set("site", site);
  form.set("trade", trade);
  form.set("projectOwnerName", "Jordan Lee");
  form.set("projectOwnerPhone", "+353 1 234 5678");
  form.set("projectOwnerEmail", "jordan@example.com");
  for (const upload of requiredUploads) {
    form.set(upload.expiry, expiryOverrides[upload.type] || "2030-06-15");
    const contents = upload.field === invalidFile ? "not a PDF" : "%PDF-1.7\nsample";
    form.set(upload.field, new Blob([contents], { type: "application/pdf" }), upload.name);
  }
  const crewIndexes = new Map();
  certificates.forEach((certificate, index) => {
    if (!crewIndexes.has(certificate.crewName)) {
      crewIndexes.set(certificate.crewName, crewIndexes.size);
    }
    const crewIndex = crewIndexes.get(certificate.crewName);
    form.set(`crewName_${crewIndex}`, certificate.crewName);
    form.set(`certificateCrew_${index}`, String(crewIndex));
    form.set(`certificateName_${index}`, certificate.name);
    form.set(
      `certificateExpiryDate_${index}`,
      expiryOverrides[`${certificate.crewName}:${certificate.name}`]
        || expiryOverrides[certificate.name]
        || certificate.expiryDate,
    );
    const field = `certificate_${index}`;
    const contents = field === invalidFile ? "not a PDF" : "%PDF-1.7\nsample";
    form.set(field, new Blob([contents], { type: "application/pdf" }), `certificate-${index}.pdf`);
  });
  return form;
}

function permitSubmission({
  permitTypes = ["Hot work permit", "Confined space permit"],
  permitOther = "",
  permitTimes = {},
} = {}) {
  const form = {
    contractorName: "Alex Morgan",
    areaLocation: "Plant room",
    permitTypes,
    permitOther,
  };
  const allowedPermitTypes = [
    "Hot work permit",
    "Confined space permit",
    "Work at height permit",
    "Other",
  ];
  permitTypes.forEach((type) => {
    const index = allowedPermitTypes.indexOf(type);
    const { startAt = "2030-06-15T08:00:00.000Z", endAt = "2030-06-15T17:00:00.000Z" } = permitTimes[type] || {};
    form[`permitStart_${index}`] = startAt;
    form[`permitEnd_${index}`] = endAt;
    if (type === "Hot work permit") {
      form[`permitContactName_${index}`] = "Taylor Chen";
      form[`permitContactEmail_${index}`] = "taylor@example.com";
      form[`permitIssuerName_${index}`] = "Casey Patel";
    }
  });
  return form;
}

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "tricel-safety-test-"));
  const app = createApp({
    databasePath: path.join(directory, "data", "test.sqlite"),
    uploadDirectory: path.join(directory, "uploads"),
    credentials,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const fixture = {
    app,
    directory,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    headers: { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}` },
  };
  activeFixtures.push(fixture);
  return fixture;
}

function submitPermit(fixture, payload) {
  return fetch(`${fixture.baseUrl}/api/permits`, {
    method: "POST",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

afterEach(async () => {
  await Promise.all(activeFixtures.splice(0).map(async ({ app, directory, server }) => {
    app.locals.database.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }));
});

test("requires authentication and persists new contractors", async () => {
  const fixture = await createFixture();
  const unauthorized = await fetch(`${fixture.baseUrl}/api/contractors`);
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate"), /Basic/);

  const homepage = await fetch(fixture.baseUrl, { headers: fixture.headers });
  assert.equal(homepage.status, 200);
  const homepageHtml = await homepage.text();
  assert.match(homepageHtml, /Welcome, Tricel/);
  assert.match(homepageHtml, /Purchasing requirements/);
  assert.match(homepageHtml, /supply-template-form/);
  assert.match(homepageHtml, /id="add-supplier-document"/);
  assert.match(homepageHtml, /id="purchasing-review-form"/);
  assert.match(homepageHtml, /name="trade" type="text" list="trade-suggestions"/);
  assert.match(homepageHtml, /<th>SITE LOCATION<\/th><th>TRADE NAME<\/th>/);
  assert.equal(homepageHtml.match(/name="trade" type="text" list="trade-suggestions"/g)?.length, 2);
  assert.match(homepageHtml, /id="finance-review-form"/);
  assert.match(homepageHtml, /name="financeEmail" type="email"/);
  assert.match(homepageHtml, /id="finance-review-notify"/);
  assert.equal(homepageHtml.match(/name="site" required/g)?.length, 2);
  for (const site of ["Tricel Weston", "Tricel Killarney", "Tricel Gloucester"]) {
    assert.match(homepageHtml, new RegExp(`<option>${site}</option>`));
  }
  const sourceFile = await fetch(`${fixture.baseUrl}/server.js`, { headers: fixture.headers });
  assert.equal(sourceFile.status, 404);

  const created = await fetch(`${fixture.baseUrl}/api/contractors`, {
    method: "POST",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Alex Morgan",
      email: "alex@example.com",
      site: "Tricel Weston",
      trade: "Industrial mechanical services",
      project: "Plant room upgrade",
    }),
  });
  assert.equal(created.status, 201);
  const contractor = await created.json();
  assert.equal(contractor.name, "Alex Morgan");
  assert.equal(contractor.site, "Tricel Weston");
  assert.equal(contractor.trade, "Industrial mechanical services");
  assert.equal(contractor.status, "Pending");

  const list = await fetch(`${fixture.baseUrl}/api/contractors`, { headers: fixture.headers });
  assert.deepEqual((await list.json()).map(({ id }) => id), [contractor.id]);
});

test("assigns a finance reviewer and saves an insurance verification decision", async () => {
  const fixture = await createFixture();
  const contractorResponse = await fetch(`${fixture.baseUrl}/api/contractors`, {
    method: "POST",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Alex Morgan",
      email: "alex@example.com",
      site: "Tricel Weston",
      trade: "Electrical",
      project: "Plant room upgrade",
    }),
  });
  const contractor = await contractorResponse.json();
  const reviewsUrl = `${fixture.baseUrl}/api/finance/reviews`;
  const initialReviews = await fetch(reviewsUrl, { headers: fixture.headers });
  assert.deepEqual(await initialReviews.json(), []);

  const invalidEmail = await fetch(`${reviewsUrl}/${contractor.id}`, {
    method: "PUT",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      financeName: "Jordan Lee",
      financeEmail: "not-an-email",
      approvalStatus: "Pending",
      comments: "",
    }),
  });
  assert.equal(invalidEmail.status, 400);

  const assignment = await fetch(`${reviewsUrl}/${contractor.id}`, {
    method: "PUT",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      financeName: "Jordan Lee",
      financeEmail: "jordan@example.com",
      approvalStatus: "Pending",
      comments: "",
    }),
  });
  assert.equal(assignment.status, 200);
  const assignedReview = await assignment.json();
  assert.equal(assignedReview.financeName, "Jordan Lee");
  assert.equal(assignedReview.financeEmail, "jordan@example.com");
  assert.equal(assignedReview.approvalStatus, "Pending");

  const decision = await fetch(`${reviewsUrl}/${contractor.id}`, {
    method: "PUT",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      financeName: "Jordan Lee",
      financeEmail: "jordan@example.com",
      approvalStatus: "Approved",
      comments: "Insurance policy verified.",
    }),
  });
  assert.equal(decision.status, 200);
  const savedReview = await decision.json();
  assert.equal(savedReview.approvalStatus, "Approved");
  assert.equal(savedReview.comments, "Insurance policy verified.");
  assert.equal(savedReview.contractorName, contractor.name);
  const persistedReviews = await fetch(reviewsUrl, { headers: fixture.headers });
  assert.deepEqual(await persistedReviews.json(), [savedReview]);
});

test("stores purchasing templates and named supplier documents for existing contractors", async () => {
  const fixture = await createFixture();
  const templateForm = new FormData();
  templateForm.set("template", new Blob(["%PDF-1.7\nblank form"], { type: "application/pdf" }), "supplier-registration.pdf");
  const templateUpload = await fetch(`${fixture.baseUrl}/api/purchasing/template`, {
    method: "POST",
    headers: fixture.headers,
    body: templateForm,
  });
  assert.equal(templateUpload.status, 201);
  assert.equal((await templateUpload.json()).originalName, "supplier-registration.pdf");

  const templateMetadata = await fetch(`${fixture.baseUrl}/api/purchasing/template`, { headers: fixture.headers });
  assert.equal((await templateMetadata.json()).originalName, "supplier-registration.pdf");
  const templateDownload = await fetch(`${fixture.baseUrl}/api/purchasing/template/download`, { headers: fixture.headers });
  assert.equal(templateDownload.status, 200);
  assert.match(templateDownload.headers.get("content-disposition"), /supplier-registration\.pdf/);
  assert.equal(await templateDownload.text(), "%PDF-1.7\nblank form");

  const contractorResponse = await fetch(`${fixture.baseUrl}/api/contractors`, {
    method: "POST",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Alex Morgan",
      email: "alex@example.com",
      site: "Tricel Weston",
      trade: "Electrical",
      project: "Plant room upgrade",
    }),
  });
  const contractor = await contractorResponse.json();
  const missingReviews = await fetch(`${fixture.baseUrl}/api/purchasing/reviews`, { headers: fixture.headers });
  assert.deepEqual(await missingReviews.json(), []);
  const invalidReview = await fetch(`${fixture.baseUrl}/api/purchasing/reviews/${contractor.id}`, {
    method: "PUT",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ reviewerName: "Jordan Lee", approvalStatus: "Maybe", comments: "Check quote." }),
  });
  assert.equal(invalidReview.status, 400);
  const savedReview = await fetch(`${fixture.baseUrl}/api/purchasing/reviews/${contractor.id}`, {
    method: "PUT",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      reviewerName: "Jordan Lee",
      approvalStatus: "Not approved",
      comments: "Please update the quotation.",
    }),
  });
  assert.equal(savedReview.status, 200);
  assert.deepEqual(await savedReview.json(), {
    contractorId: contractor.id,
    contractorName: contractor.name,
    reviewerName: "Jordan Lee",
    approvalStatus: "Not approved",
    comments: "Please update the quotation.",
    updatedAt: (await fixture.app.locals.database.prepare(
      "SELECT updated_at FROM purchasing_reviews WHERE contractor_id = ?",
    ).get(contractor.id)).updated_at,
  });

  const invalidForm = new FormData();
  invalidForm.set("contractorId", "missing-contractor");
  invalidForm.set("type", "quotation");
  invalidForm.set("documentName", "Plant room quote");
  invalidForm.set("file", new Blob(["%PDF-1.7\nquote"], { type: "application/pdf" }), "quote.pdf");
  const invalidUpload = await fetch(`${fixture.baseUrl}/api/purchasing/documents`, {
    method: "POST",
    headers: fixture.headers,
    body: invalidForm,
  });
  assert.equal(invalidUpload.status, 404);

  const uploadedRecords = [];
  for (const { type, documentName, fileName } of [
    { type: "registration", documentName: "Completed supply form", fileName: "registration.pdf" },
    { type: "quotation", documentName: "Plant room quote", fileName: "quote.pdf" },
    { type: "other", documentName: "Product specification", fileName: "specification.pdf" },
  ]) {
    const form = new FormData();
    form.set("contractorId", contractor.id);
    form.set("type", type);
    form.set("documentName", documentName);
    form.set("file", new Blob([`%PDF-1.7\n${type}`], { type: "application/pdf" }), fileName);
    const response = await fetch(`${fixture.baseUrl}/api/purchasing/documents`, {
      method: "POST",
      headers: fixture.headers,
      body: form,
    });
    assert.equal(response.status, 201);
    uploadedRecords.push(await response.json());
  }
  assert.ok(uploadedRecords.every(({ contractorId, contractorName }) =>
    contractorId === contractor.id && contractorName === contractor.name,
  ));

  const purchasingList = await fetch(`${fixture.baseUrl}/api/purchasing/documents`, { headers: fixture.headers });
  const storedDocuments = await purchasingList.json();
  assert.equal(storedDocuments.length, 3);
  assert.deepEqual(new Set(storedDocuments.map(({ type }) => type)), new Set(["registration", "quotation", "other"]));
  const quotation = storedDocuments.find(({ type }) => type === "quotation");
  assert.equal(quotation.documentName, "Plant room quote");
  const quotationDownload = await fetch(
    `${fixture.baseUrl}/api/purchasing/documents/${quotation.id}/download`,
    { headers: fixture.headers },
  );
  assert.equal(quotationDownload.status, 200);
  assert.match(quotationDownload.headers.get("content-disposition"), /quote\.pdf/);
  assert.equal(await quotationDownload.text(), "%PDF-1.7\nquotation");
});

test("requires a supported contractor site", async () => {
  const fixture = await createFixture();
  const response = await fetch(`${fixture.baseUrl}/api/contractors`, {
    method: "POST",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Alex Morgan",
      email: "alex@example.com",
      site: "Tricel Dublin",
      trade: "Electrical",
      project: "Plant room upgrade",
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid site location/i);
});

test("requires base documents and named certifications with current expiries", async () => {
  const fixture = await createFixture();
  const incompleteForm = new FormData();
  incompleteForm.set("contractorName", "Alex Morgan");
  incompleteForm.set("areaLocation", "Plant room");
  incompleteForm.set("insuranceExpiryDate", "2030-06-15");
  incompleteForm.set("insurance", new Blob(["%PDF-1.7\nsample"], { type: "application/pdf" }), "insurance.pdf");
  const incomplete = await fetch(`${fixture.baseUrl}/api/documents`, {
    method: "POST",
    headers: fixture.headers,
    body: incompleteForm,
  });
  assert.equal(incomplete.status, 400);
  assert.match((await incomplete.json()).error, /at least one certification/i);

  const invalidDate = await fetch(`${fixture.baseUrl}/api/documents`, {
    method: "POST",
    headers: fixture.headers,
    body: documentBundle({ expiryOverrides: { rams: "2027-02-29" } }),
  });
  assert.equal(invalidDate.status, 400);
  assert.match((await invalidDate.json()).error, /rams expiry date/i);

  const invalidOwnerEmailForm = documentBundle();
  invalidOwnerEmailForm.set("projectOwnerEmail", "not-an-email");
  const invalidOwnerEmail = await fetch(`${fixture.baseUrl}/api/documents`, {
    method: "POST",
    headers: fixture.headers,
    body: invalidOwnerEmailForm,
  });
  assert.equal(invalidOwnerEmail.status, 400);
  assert.match((await invalidOwnerEmail.json()).error, /valid project owner email address/i);

  const invalidSite = await fetch(`${fixture.baseUrl}/api/documents`, {
    method: "POST",
    headers: fixture.headers,
    body: documentBundle({ site: "Tricel Dublin" }),
  });
  assert.equal(invalidSite.status, 400);
  assert.match((await invalidSite.json()).error, /valid site location/i);

  const crewWithoutCertification = documentBundle();
  crewWithoutCertification.set("crewName_2", "Crew Gamma");
  const invalidCrew = await fetch(`${fixture.baseUrl}/api/documents`, {
    method: "POST",
    headers: fixture.headers,
    body: crewWithoutCertification,
  });
  assert.equal(invalidCrew.status, 400);
  assert.match((await invalidCrew.json()).error, /certification for each crew/i);

  const contractorsAfterInvalidSubmission = await fetch(`${fixture.baseUrl}/api/contractors`, { headers: fixture.headers });
  assert.deepEqual(await contractorsAfterInvalidSubmission.json(), []);

  const uploaded = await fetch(`${fixture.baseUrl}/api/documents`, {
    method: "POST",
    headers: fixture.headers,
    body: documentBundle(),
  });
  assert.equal(uploaded.status, 201);
  const submission = await uploaded.json();
  assert.equal(submission.documents.length, 6);
  const certificates = submission.documents.filter(({ type }) => type === "job_certification");
  const document = certificates[0];
  assert.equal(certificates.length, 3);
  assert.deepEqual(certificates.map(({ jobName }) => jobName), [
    "Working at height",
    "Confined space entry",
    "Working at height",
  ]);
  assert.deepEqual(certificates.map(({ crewName }) => crewName), ["Crew Alpha", "Crew Alpha", "Crew Beta"]);
  assert.equal(document.contractorName, "Alex Morgan");
  assert.equal(document.areaLocation, "Plant room");
  assert.equal(document.projectOwnerName, "Jordan Lee");
  assert.equal(document.projectOwnerPhone, "+353 1 234 5678");
  assert.equal(document.projectOwnerEmail, "jordan@example.com");
  assert.equal(document.permitsRequired, "");
  assert.ok(submission.documents.every(({ submissionId }) => submissionId === document.submissionId));
  assert.equal(document.expiryDate, "2030-06-15");
  const contractorList = await fetch(`${fixture.baseUrl}/api/contractors`, { headers: fixture.headers });
  const [createdContractor] = await contractorList.json();
  assert.equal(createdContractor.name, "Alex Morgan");
  assert.equal(createdContractor.project, "Plant room");
  assert.equal(createdContractor.site, "Tricel Weston");
  assert.equal(createdContractor.trade, "Electrical");
  assert.equal(createdContractor.status, "Complete");
  const documentList = await fetch(`${fixture.baseUrl}/api/documents`, { headers: fixture.headers });
  const storedDocuments = await documentList.json();
  assert.equal(storedDocuments.length, 6);
  const storedDocument = storedDocuments.find(({ type, jobName, crewName }) =>
    type === "job_certification" && jobName === "Working at height" && crewName === "Crew Alpha",
  );
  assert.equal(storedDocument.expiryDate, "2030-06-15");
  assert.equal(storedDocument.crewName, "Crew Alpha");
  assert.equal(storedDocument.areaLocation, "Plant room");
  assert.equal(storedDocument.projectOwnerName, "Jordan Lee");
  assert.equal(storedDocument.projectOwnerPhone, "+353 1 234 5678");
  assert.equal(storedDocument.projectOwnerEmail, "jordan@example.com");

  const download = await fetch(`${fixture.baseUrl}/api/documents/${document.id}/download`, {
    headers: fixture.headers,
  });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /certificate-0\.pdf/);
  assert.equal(await download.text(), "%PDF-1.7\nsample");

  const expiredBundle = await fetch(`${fixture.baseUrl}/api/documents`, {
    method: "POST",
    headers: fixture.headers,
    body: documentBundle({
      expiryOverrides: { "Crew Alpha:Working at height": "2020-06-15" },
      site: "Tricel Killarney",
      trade: "Specialist pipefitting",
    }),
  });
  assert.equal(expiredBundle.status, 201);
  let updatedContractors = await fetch(`${fixture.baseUrl}/api/contractors`, { headers: fixture.headers });
  let [updatedContractor] = await updatedContractors.json();
  assert.equal(updatedContractor.status, "Pending");
  assert.equal(updatedContractor.site, "Tricel Killarney");
  assert.equal(updatedContractor.trade, "Specialist pipefitting");

  const renewedBundle = await fetch(`${fixture.baseUrl}/api/documents`, {
    method: "POST",
    headers: fixture.headers,
    body: documentBundle(),
  });
  assert.equal(renewedBundle.status, 201);
  updatedContractors = await fetch(`${fixture.baseUrl}/api/contractors`, { headers: fixture.headers });
  [updatedContractor] = await updatedContractors.json();
  assert.equal(updatedContractor.status, "Complete");
  fixture.app.locals.database.prepare(`
    UPDATE documents SET expiry_date = '2020-06-15'
    WHERE contractor_id = ? AND type = 'rams' AND uploaded_at = (
      SELECT MAX(uploaded_at) FROM documents WHERE contractor_id = ? AND type = 'rams'
    )
  `).run(createdContractor.id, createdContractor.id);
  const expiredDocuments = await fetch(`${fixture.baseUrl}/api/contractors`, { headers: fixture.headers });
  const [contractorWithExpiredDocument] = await expiredDocuments.json();
  assert.equal(contractorWithExpiredDocument.status, "Pending");

  const invalid = await fetch(`${fixture.baseUrl}/api/documents`, {
    method: "POST",
    headers: fixture.headers,
    body: documentBundle({ invalidFile: "rams" }),
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /rams file content does not match/i);
  const finalDocumentList = await fetch(`${fixture.baseUrl}/api/documents`, { headers: fixture.headers });
  assert.equal((await finalDocumentList.json()).length, 18);

  const permitList = await fetch(`${fixture.baseUrl}/api/permits`, { headers: fixture.headers });
  const storedPermits = await permitList.json();
  assert.deepEqual(storedPermits, []);
});

test("requires details when Other is the selected permit", async () => {
  const fixture = await createFixture();
  const missingDetails = await submitPermit(fixture, permitSubmission({ permitTypes: ["Other"] }));

  assert.equal(missingDetails.status, 400);
  assert.match((await missingDetails.json()).error, /other permit details/i);

  const missingTimes = await submitPermit(fixture, permitSubmission({
      permitTypes: ["Other"],
      permitOther: "Electrical isolation",
      permitTimes: { Other: { startAt: "", endAt: "" } },
    }));
  assert.equal(missingTimes.status, 400);
  assert.match((await missingTimes.json()).error, /valid other start date and time/i);

  const submission = await submitPermit(fixture, permitSubmission({
    permitTypes: ["Other"],
    permitOther: "Electrical isolation",
  }));
  assert.equal(submission.status, 201);
  const { permits: submittedPermits } = await submission.json();
  assert.equal(submittedPermits[0].details, "Electrical isolation");
  const permits = await fetch(`${fixture.baseUrl}/api/permits`, { headers: fixture.headers });
  const [otherPermit] = await permits.json();
  assert.equal(otherPermit.type, "Other");
  assert.equal(otherPermit.details, "Electrical isolation");
  const documents = await fetch(`${fixture.baseUrl}/api/documents`, { headers: fixture.headers });
  assert.deepEqual(await documents.json(), []);
});

test("stores and downloads an optional permit document", async () => {
  const fixture = await createFixture();
  const makeForm = (contents = "%PDF-1.7\npermit document") => {
    const form = new FormData();
    const submission = permitSubmission({ permitTypes: ["Other"], permitOther: "Electrical isolation" });
    Object.entries(submission).forEach(([key, value]) => {
      if (Array.isArray(value)) value.forEach((item) => form.append(key, item));
      else form.set(key, value);
    });
    form.set("permitDocument", new Blob([contents], { type: "application/pdf" }), "permit.pdf");
    return form;
  };

  const response = await fetch(`${fixture.baseUrl}/api/permits`, {
    method: "POST",
    headers: fixture.headers,
    body: makeForm(),
  });
  assert.equal(response.status, 201);
  const { permits: submittedPermits } = await response.json();
  const permit = submittedPermits[0];
  assert.equal(permit.documentName, "permit.pdf");

  const unauthorizedDownload = await fetch(`${fixture.baseUrl}/api/permits/${permit.id}/document`);
  assert.equal(unauthorizedDownload.status, 401);
  const download = await fetch(`${fixture.baseUrl}/api/permits/${permit.id}/document`, {
    headers: fixture.headers,
  });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /permit\.pdf/);
  assert.equal(await download.text(), "%PDF-1.7\npermit document");

  const invalidFile = await fetch(`${fixture.baseUrl}/api/permits`, {
    method: "POST",
    headers: fixture.headers,
    body: makeForm("not a PDF"),
  });
  assert.equal(invalidFile.status, 400);
  assert.match((await invalidFile.json()).error, /permit document file content does not match/i);
  const permitList = await fetch(`${fixture.baseUrl}/api/permits`, { headers: fixture.headers });
  assert.equal((await permitList.json()).length, 1);
});

test("requires valid responsible contact and Health & Safety issuer for hot work permits", async () => {
  const fixture = await createFixture();
  const missingContact = permitSubmission();
  delete missingContact.permitContactName_0;
  const missingContactResponse = await submitPermit(fixture, missingContact);
  assert.equal(missingContactResponse.status, 400);
  assert.match((await missingContactResponse.json()).error, /hot work person in charge name/i);

  const invalidEmail = permitSubmission();
  invalidEmail.permitContactEmail_0 = "not-an-email";
  const invalidEmailResponse = await submitPermit(fixture, invalidEmail);
  assert.equal(invalidEmailResponse.status, 400);
  assert.match((await invalidEmailResponse.json()).error, /valid hot work person in charge email address/i);

  const missingIssuer = permitSubmission();
  delete missingIssuer.permitIssuerName_0;
  const missingIssuerResponse = await submitPermit(fixture, missingIssuer);
  assert.equal(missingIssuerResponse.status, 400);
  assert.match((await missingIssuerResponse.json()).error, /health & safety issuer name/i);

  const invalidPeriod = permitSubmission({
    permitTimes: {
      "Hot work permit": {
        startAt: "2030-06-15T17:00:00.000Z",
        endAt: "2030-06-15T08:00:00.000Z",
      },
    },
  });
  const invalidPeriodResponse = await submitPermit(fixture, invalidPeriod);
  assert.equal(invalidPeriodResponse.status, 400);
  assert.match((await invalidPeriodResponse.json()).error, /end date and time must be after/i);

  const allPermits = permitSubmission({
    permitTypes: ["Hot work permit", "Confined space permit", "Work at height permit", "Other"],
    permitOther: "Electrical isolation",
  });
  const allPermitsResponse = await submitPermit(fixture, allPermits);
  assert.equal(allPermitsResponse.status, 201);
  const permits = await fetch(`${fixture.baseUrl}/api/permits`, { headers: fixture.headers });
  assert.equal((await permits.json()).length, 4);
});

test("saves contractor approval and per-document verification with comments", async () => {
  const fixture = await createFixture();
  const created = await fetch(`${fixture.baseUrl}/api/contractors`, {
    method: "POST",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Alex Morgan",
      email: "alex@example.com",
      site: "Tricel Weston",
      trade: "Electrical",
      project: "Plant room upgrade",
    }),
  });
  const contractor = await created.json();

  const approvalWithoutReviewer = await fetch(`${fixture.baseUrl}/api/contractors/${contractor.id}/review`, {
    method: "PATCH",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ approvalStatus: "Approved", approvedBy: "", reviewComments: "" }),
  });
  assert.equal(approvalWithoutReviewer.status, 400);
  assert.match((await approvalWithoutReviewer.json()).error, /who approved/i);

  const approval = await fetch(`${fixture.baseUrl}/api/contractors/${contractor.id}/review`, {
    method: "PATCH",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      approvalStatus: "Approved",
      approvedBy: "Morgan Reviewer",
      reviewComments: "Site induction confirmed.",
    }),
  });
  assert.equal(approval.status, 200);
  const reviewedContractor = await approval.json();
  assert.equal(reviewedContractor.approvalStatus, "Approved");
  assert.equal(reviewedContractor.approvedBy, "Morgan Reviewer");
  assert.equal(reviewedContractor.reviewComments, "Site induction confirmed.");

  const submission = await fetch(`${fixture.baseUrl}/api/documents`, {
    method: "POST",
    headers: fixture.headers,
    body: documentBundle(),
  });
  assert.equal(submission.status, 201);
  const { documents: submittedDocuments } = await submission.json();
  const document = submittedDocuments[0];

  const verificationWithoutReviewer = await fetch(`${fixture.baseUrl}/api/documents/${document.id}/review`, {
    method: "PATCH",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ verificationStatus: "Verified", verifiedBy: "", reviewComments: "" }),
  });
  assert.equal(verificationWithoutReviewer.status, 400);
  assert.match((await verificationWithoutReviewer.json()).error, /who verified/i);

  const verification = await fetch(`${fixture.baseUrl}/api/documents/${document.id}/review`, {
    method: "PATCH",
    headers: { ...fixture.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      verificationStatus: "Verified",
      verifiedBy: "Morgan Reviewer",
      reviewComments: "Original file checked.",
    }),
  });
  assert.equal(verification.status, 200);
  const verifiedDocument = await verification.json();
  assert.equal(verifiedDocument.verificationStatus, "Verified");
  assert.equal(verifiedDocument.verifiedBy, "Morgan Reviewer");
  assert.equal(verifiedDocument.reviewComments, "Original file checked.");

  const contractors = await fetch(`${fixture.baseUrl}/api/contractors`, { headers: fixture.headers });
  assert.equal((await contractors.json())[0].approvalStatus, "Approved");
  const documents = await fetch(`${fixture.baseUrl}/api/documents`, { headers: fixture.headers });
  const storedDocument = (await documents.json()).find(({ id }) => id === document.id);
  assert.equal(storedDocument.verificationStatus, "Verified");
  assert.equal(storedDocument.verifiedBy, "Morgan Reviewer");
  assert.equal(storedDocument.reviewComments, "Original file checked.");
});
