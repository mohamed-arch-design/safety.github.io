const documentTypes = [
  { value: "insurance", label: "Insurance" },
  { value: "safety_statement", label: "Company safety statement" },
  { value: "rams", label: "RAMS" },
  { value: "job_certification", label: "Job-specific certification" },
];
const baseDocumentTypes = documentTypes.filter(({ value }) => value !== "job_certification");
const maxCrews = 10;
const maxCertificates = 10;
const contractorSites = [
  { value: "Tricel Weston", countId: "site-count-weston" },
  { value: "Tricel Killarney", countId: "site-count-killarney" },
  { value: "Tricel Gloucester", countId: "site-count-gloucester" },
];

const rows = document.querySelector("#contractor-rows");
const emptyState = document.querySelector("#empty-state");
const contractorSearch = document.querySelector("#contractor-search");
const statusFilter = document.querySelector("#status-filter");
const toast = document.querySelector("#toast");
const dialog = document.querySelector("#contractor-dialog");
const contractorForm = document.querySelector("#contractor-form");
const documentForm = document.querySelector("#document-form");
const permitForm = document.querySelector("#permit-form");
const contractorDetailsDialog = document.querySelector("#contractor-details-dialog");
const pendingDocumentsDialog = document.querySelector("#pending-documents-dialog");
const contractors = [];
let documents = [];
let permits = [];
let purchasingDocuments = [];
let purchasingTemplate = null;
let purchasingReviews = [];
let financeReviews = [];
let nextSupplierDocumentIndex = 1;
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3500);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

async function apiRequest(url, options) {
  const response = await fetch(url, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function documentSummary(contractorId) {
  const today = new Date().toISOString().slice(0, 10);
  const latestDocuments = getLatestDocuments(contractorId);
  const receivedBase = baseDocumentTypes.filter(({ value }) =>
    latestDocuments.some((document) => document.type === value && document.expiryDate >= today),
  ).length;
  const certificates = latestDocuments.filter(({ type, crewName }) => type === "job_certification" && crewName);
  const currentCertificates = certificates.filter(({ expiryDate }) => expiryDate >= today).length;
  return `${receivedBase + currentCertificates} / ${3 + Math.max(1, certificates.length)}`;
}

function getLatestDocuments(contractorId) {
  const latestDocuments = new Map();
  documents.filter((document) => document.contractorId === contractorId).forEach((document) => {
    const requirement = document.type === "job_certification"
      ? `${document.type}:${document.crewName}:${document.jobName}`
      : document.type;
    if (!latestDocuments.has(requirement)) latestDocuments.set(requirement, document);
  });
  return [...latestDocuments.values()];
}

function getPendingRequirements(contractorId) {
  const today = new Date().toISOString().slice(0, 10);
  const latestDocuments = getLatestDocuments(contractorId);
  const receivedBase = baseDocumentTypes.filter(({ value }) =>
    latestDocuments.some((document) => document.type === value && document.expiryDate >= today),
  ).length;
  const certificates = latestDocuments.filter(({ type, crewName }) => type === "job_certification" && crewName);
  const currentCertificates = certificates.filter(({ expiryDate }) => expiryDate >= today).length;
  return 3 - receivedBase + (certificates.length ? certificates.length - currentCertificates : 1);
}

function getMissingRequirements(contractorId) {
  const today = new Date().toISOString().slice(0, 10);
  const latestDocuments = getLatestDocuments(contractorId);
  const missing = baseDocumentTypes.flatMap(({ value, label }) => {
    const latestDocument = latestDocuments.find(({ type }) => type === value);
    if (latestDocument && latestDocument.expiryDate >= today) return [];
    return [`${label} — ${latestDocument ? getExpiryStatus(latestDocument.expiryDate).text : "not submitted"}`];
  });
  const certificates = latestDocuments.filter(({ type, crewName }) => type === "job_certification" && crewName);
  if (!certificates.length) {
    missing.push("Crew certification — at least one named certification is required");
  } else {
    certificates.filter(({ expiryDate }) => !expiryDate || expiryDate < today).forEach((certificate) => {
      const crew = certificate.crewName || "Crew member";
      const name = certificate.jobName || "Job-specific certification";
      missing.push(`${crew} — ${name}: ${getExpiryStatus(certificate.expiryDate).text}`);
    });
  }
  return missing;
}

function renderPendingDocuments() {
  const pending = contractors.map((contractor) => ({
    contractor,
    missing: getMissingRequirements(contractor.id),
  })).filter(({ missing }) => missing.length);
  const list = document.querySelector("#pending-contractor-list");
  if (!pending.length) {
    list.innerHTML = '<div class="pending-documents-empty">All contractors have their required documents up to date.</div>';
    return;
  }
  list.innerHTML = pending.map(({ contractor, missing }) => `<article class="pending-contractor-card">
    <div class="pending-contractor-heading">
      <strong>${escapeHtml(contractor.name)}</strong>
      <span>${missing.length} requirement${missing.length === 1 ? "" : "s"} pending</span>
    </div>
    <p>${escapeHtml(contractor.site || "Unassigned")} · ${escapeHtml(contractor.project || "Project not recorded")}</p>
    <ul>${missing.map((requirement) => `<li>${escapeHtml(requirement)}</li>`).join("")}</ul>
  </article>`).join("");
}

function renderContractorDetails(contractorId) {
  const contractor = contractors.find(({ id }) => id === contractorId);
  if (!contractor) return;
  const contractorDocuments = documents.filter(({ contractorId: id }) => id === contractor.id);
  const crewMembers = new Map();
  contractorDocuments.filter(({ type }) => type === "job_certification").forEach((certificate) => {
    const crewName = certificate.crewName || "Crew member not recorded";
    if (!crewMembers.has(crewName)) crewMembers.set(crewName, []);
    crewMembers.get(crewName).push(certificate);
  });
  const profileTitle = document.querySelector("#contractor-profile-title");
  profileTitle.textContent = contractor.name;
  document.querySelector("#contractor-profile-summary").textContent =
    [contractor.trade, contractor.project, contractor.site || "Unassigned"].filter(Boolean).join(" · ");

  const profileContent = document.querySelector("#contractor-profile-content");
  const approvalStatus = contractor.approvalStatus || "Pending";
  const complianceSummary = contractor.status === "Complete"
    ? "All required documents are current"
    : "Required documents are missing or expired";
  const approvalByRequired = approvalStatus === "Approved" ? "required" : "";
  const approvalOptions = ["Pending", "Approved"].map((status) =>
    `<option value="${status}" ${approvalStatus === status ? "selected" : ""}>${status === "Approved" ? "Approved by Tricel" : "Pending review"}</option>`
  ).join("");
  const crewSection = crewMembers.size
    ? [...crewMembers].map(([crewName, certificates]) => `<article class="profile-crew">
        <h4>${escapeHtml(crewName)}</h4>
        <ul>${certificates.map((certificate) => `<li>
          <span>${escapeHtml(certificate.jobName || "Job-specific certification")}</span>
          <span>${escapeHtml(getExpiryStatus(certificate.expiryDate).text)}</span>
        </li>`).join("")}</ul>
      </article>`).join("")
    : '<p class="profile-empty">No crew or certifications have been submitted.</p>';
  const documentSection = contractorDocuments.length
    ? contractorDocuments.map((item) => {
      const type = documentTypes.find(({ value }) => value === item.type);
      const title = type?.label || "Document";
      const crew = item.crewName ? ` · ${escapeHtml(item.crewName)}` : "";
      const job = item.jobName ? ` · ${escapeHtml(item.jobName)}` : "";
      const expiry = getExpiryStatus(item.expiryDate);
      const owner = item.projectOwnerName
        ? `<span>Project owner: ${escapeHtml(item.projectOwnerName)} · ${escapeHtml(item.projectOwnerPhone || "No phone recorded")} · ${escapeHtml(item.projectOwnerEmail || "No email recorded")}</span>`
        : "";
      const verificationStatus = item.verificationStatus || "Unverified";
      const verificationOptions = ["Unverified", "Verified"].map((status) =>
        `<option value="${status}" ${verificationStatus === status ? "selected" : ""}>${status === "Verified" ? "Verified" : "Not verified"}</option>`
      ).join("");
      return `<article class="profile-document">
        <div class="profile-document-heading"><strong>${escapeHtml(title)}${crew}${job}</strong><span class="expiry-status ${expiry.className}">${escapeHtml(expiry.text)}</span></div>
        <span>${escapeHtml(item.originalName)} · ${escapeHtml(item.areaLocation || "Area not recorded")} · Uploaded ${escapeHtml(new Date(item.uploadedAt).toLocaleDateString())}</span>
        ${owner}
        <a class="text-button" href="/api/documents/${encodeURIComponent(item.id)}/download">Download document</a>
        <form class="profile-review-form profile-document-review" data-document-review data-document-id="${escapeHtml(item.id)}">
          <label class="form-field"><span>Document verification</span><select name="verificationStatus">${verificationOptions}</select></label>
          <label class="form-field"><span>Verified by</span><input name="verifiedBy" type="text" maxlength="80" value="${escapeHtml(item.verifiedBy || "")}" ${verificationStatus === "Verified" ? "required" : ""} /></label>
          <label class="form-field profile-comment-field"><span>Document comments</span><textarea name="reviewComments" maxlength="2000">${escapeHtml(item.reviewComments || "")}</textarea></label>
          <button class="button button-secondary" type="submit">Save document review</button>
        </form>
      </article>`;
    }).join("")
    : '<p class="profile-empty">No documents have been submitted.</p>';

  profileContent.innerHTML = `<section class="profile-section">
      <h3>Contact &amp; work details</h3>
      <dl class="profile-facts">
        <div><dt>Email</dt><dd>${escapeHtml(contractor.email || "No email recorded")}</dd></div>
        <div><dt>Trade name</dt><dd>${escapeHtml(contractor.trade || "Not recorded")}</dd></div>
        <div><dt>Project / job</dt><dd>${escapeHtml(contractor.project || "Not recorded")}</dd></div>
        <div><dt>Site location</dt><dd>${escapeHtml(contractor.site || "Unassigned")}</dd></div>
        <div><dt>Compliance</dt><dd>${escapeHtml(contractor.status || "Not recorded")}</dd></div>
      </dl>
    </section>
    <section class="profile-section">
      <h3>Tricel approval</h3>
      <p class="profile-compliance ${contractor.status === "Complete" ? "is-complete" : "is-pending"}">${escapeHtml(complianceSummary)}</p>
      <form class="profile-review-form" data-contractor-review data-contractor-id="${escapeHtml(contractor.id)}">
        <label class="form-field"><span>Approval status</span><select name="approvalStatus">${approvalOptions}</select></label>
        <label class="form-field"><span>Approved by</span><input name="approvedBy" type="text" maxlength="80" value="${escapeHtml(contractor.approvedBy || "")}" ${approvalByRequired} /></label>
        <label class="form-field profile-comment-field"><span>Additional comments</span><textarea name="reviewComments" maxlength="2000">${escapeHtml(contractor.reviewComments || "")}</textarea></label>
        <button class="button button-secondary" type="submit">Save contractor review</button>
      </form>
    </section>
    <section class="profile-section"><h3>Crew &amp; certifications</h3>${crewSection}</section>
    <section class="profile-section"><h3>All documents (${contractorDocuments.length})</h3><div class="profile-documents">${documentSection}</div></section>`;
  if (!contractorDetailsDialog.open) contractorDetailsDialog.showModal();
}

function renderContractors() {
  const query = contractorSearch.value.trim().toLowerCase();
  const selectedStatus = statusFilter.value;
  const visible = contractors.filter((contractor) => {
    const matchesQuery = [contractor.name, contractor.email, contractor.trade, contractor.project, contractor.site || "Unassigned"]
      .some((value) => value.toLowerCase().includes(query));
    return matchesQuery && (selectedStatus === "all" || contractor.status === selectedStatus);
  });

  rows.innerHTML = visible.map((contractor) => {
    const [received, required] = documentSummary(contractor.id).split(" / ").map(Number);
    const statusClass = contractor.status.toLowerCase();
    const initials = contractor.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    return `<tr>
      <td><button class="contractor-person contractor-profile-button" type="button" data-view-contractor="${escapeHtml(contractor.id)}" aria-label="View profile for ${escapeHtml(contractor.name)}"><span class="avatar avatar-mint">${escapeHtml(initials)}</span><span class="contractor-details"><strong>${escapeHtml(contractor.name)}</strong><span>${escapeHtml(contractor.email || "No email recorded")}</span></span></button></td>
      <td>${escapeHtml(contractor.site || "Unassigned")}</td>
      <td>${escapeHtml(contractor.trade)}</td>
      <td>${escapeHtml(contractor.project)}</td>
      <td><span class="table-status table-status-${statusClass}"><span></span>${escapeHtml(contractor.status)}</span></td>
      <td><span class="docs-count ${received < required ? "docs-warning" : ""}"><svg class="icon"><use href="#i-file"/></svg>${received} / ${required}</span></td>
      <td>${escapeHtml(new Date(contractor.createdAt).toLocaleDateString())}</td>
      <td><button class="row-menu" type="button" aria-label="View documents for ${escapeHtml(contractor.name)}" data-contractor="${escapeHtml(contractor.id)}"><svg class="icon"><use href="#i-more"/></svg></button></td>
    </tr>`;
  }).join("");

  emptyState.hidden = visible.length > 0;
  document.querySelector("#showing-count").textContent = String(visible.length);
  document.querySelector("#total-count").textContent = String(contractors.length);
  document.querySelector("#contractor-heading-count").textContent = String(contractors.length);
  document.querySelector("#contractor-total").textContent = String(contractors.length);
  document.querySelector("#nav-contractor-count").textContent = String(contractors.length);
  const siteCounts = new Map(contractorSites.map(({ value }) => [value, 0]));
  let unassignedCount = 0;
  contractors.forEach(({ site }) => {
    if (siteCounts.has(site)) siteCounts.set(site, siteCounts.get(site) + 1);
    else unassignedCount += 1;
  });
  contractorSites.forEach(({ value, countId }) => {
    document.querySelector(`#${countId}`).textContent = String(siteCounts.get(value));
  });
  const unassignedNote = document.querySelector("#site-unassigned-note");
  unassignedNote.hidden = unassignedCount === 0;
  unassignedNote.textContent = `${unassignedCount} contractor${unassignedCount === 1 ? "" : "s"} ${unassignedCount === 1 ? "is" : "are"} not assigned to a site.`;
  const pendingCount = contractors.reduce((total, contractor) => total + getPendingRequirements(contractor.id), 0);
  document.querySelector("#pending-documents").textContent = String(pendingCount);
  renderApprovedContractors();
  renderProjects();
  renderExpiryAlerts();
}

function renderApprovedContractors() {
  const selectedSite = document.querySelector("#approved-site-filter").value;
  const approved = contractors.filter(({ approvalStatus, site }) =>
    approvalStatus === "Approved" && (selectedSite === "all" || site === selectedSite),
  );
  const list = document.querySelector("#approved-contractor-list");
  document.querySelector("#approved-contractor-count").textContent = String(approved.length);
  if (!approved.length) {
    list.innerHTML = selectedSite === "all"
      ? '<div class="profile-empty">No contractors have been approved yet.</div>'
      : '<div class="profile-empty">No approved contractors for this site.</div>';
    return;
  }
  list.innerHTML = approved.map((contractor) => {
    const compliant = contractor.status === "Complete";
    return `<article class="approved-contractor-card">
      <div class="approved-contractor-heading">
        <button class="approved-contractor-name" type="button" data-view-contractor="${escapeHtml(contractor.id)}">${escapeHtml(contractor.name)}</button>
        <span class="approval-badge">Approved by Tricel</span>
      </div>
      <span class="approved-contractor-context">${escapeHtml(contractor.project || "Project not recorded")} · ${escapeHtml(contractor.site || "Unassigned")}</span>
      <div class="approved-contractor-review">
        <span>Reviewed by ${escapeHtml(contractor.approvedBy || "Not recorded")}</span>
        <span class="approved-compliance ${compliant ? "is-complete" : "is-pending"}">${compliant ? "All required documents are current" : "Compliance needs attention"}</span>
        <p>${escapeHtml(contractor.reviewComments || "No additional review comments.")}</p>
      </div>
    </article>`;
  }).join("");
}

function getExpiryStatus(expiryDate) {
  if (!expiryDate) return { text: "Expiry not recorded", className: "expiry-expired", alert: true };
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysUntilExpiry = Math.ceil((Date.parse(`${expiryDate}T00:00:00Z`) - today.getTime()) / 86400000);
  if (daysUntilExpiry < 0) {
    return { text: `Expired ${expiryDate}`, className: "expiry-expired", alert: true };
  }
  if (daysUntilExpiry <= 30) {
    return {
      text: daysUntilExpiry === 0 ? "Expires today" : `Expires in ${daysUntilExpiry} days`,
      className: "expiry-warning",
      alert: true,
    };
  }
  return { text: `Expires ${expiryDate}`, className: "", alert: false };
}

function renderExpiryAlerts() {
  const latestDocuments = new Map();
  documents.forEach((document) => {
    const requirement = document.type === "job_certification"
      ? `${document.type}:${document.crewName}:${document.jobName}`
      : document.type;
    const key = `${document.contractorId}:${requirement}`;
    if (!latestDocuments.has(key)) latestDocuments.set(key, document);
  });
  document.querySelector("#expiry-alerts").textContent = String(
    [...latestDocuments.values()].filter(({ expiryDate }) => getExpiryStatus(expiryDate).alert).length,
  );
}

function renderPermits() {
  const now = Date.now();
  const currentPermits = permits.filter(({ endAt }) => Date.parse(endAt) >= now);
  currentPermits.sort((first, second) =>
    Number(Date.parse(first.startAt) > now) - Number(Date.parse(second.startAt) > now)
      || Date.parse(first.startAt) - Date.parse(second.startAt),
  );
  const liveCount = currentPermits.filter(({ startAt }) => Date.parse(startAt) <= now).length;
  document.querySelector("#permit-total").textContent = String(liveCount);
  const list = document.querySelector("#permit-list");
  if (!currentPermits.length) {
    list.innerHTML = '<div class="permit-empty">No live or upcoming permits are scheduled.</div>';
    return;
  }
  const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  list.innerHTML = currentPermits.map((permit) => {
    const live = Date.parse(permit.startAt) <= now;
    const details = permit.details ? ` · ${escapeHtml(permit.details)}` : "";
    const responsibility = permit.contactName
      ? `<span class="permit-responsibility">In charge: ${escapeHtml(permit.contactName)} · ${escapeHtml(permit.contactEmail)} · Issued by: ${escapeHtml(permit.issuerName)}</span>`
      : "";
    const permitDocument = permit.documentName
       ? `<a class="permit-document-link" href="/api/permits/${encodeURIComponent(permit.id)}/document">Permit document: ${escapeHtml(permit.documentName)}</a>`
       : "";
    return `<article class="permit-item">
      <div class="permit-contractor"><strong>${escapeHtml(permit.contractorName)}</strong><span>${escapeHtml(permit.areaLocation)}</span></div>
      <div class="permit-description"><strong>${escapeHtml(permit.type)}${details}</strong><span>${escapeHtml(dateTimeFormat.format(new Date(permit.startAt)))} – ${escapeHtml(dateTimeFormat.format(new Date(permit.endAt)))}</span>${responsibility}${permitDocument}</div>
      <span class="permit-status ${live ? "permit-status-live" : "permit-status-upcoming"}">${live ? "Live" : "Upcoming"}</span>
    </article>`;
  }).join("");
}
window.setInterval(renderPermits, 60_000);

function renderProjects() {
  const projects = new Map();
  contractors.forEach((contractor) => {
    projects.set(contractor.project, (projects.get(contractor.project) || 0) + 1);
  });
  const projectList = document.querySelector("#project-list");
  document.querySelector("#project-total").textContent = String(projects.size);
  if (!projects.size) {
    projectList.innerHTML = '<div class="project-empty">Jobs will appear when you add contractors.</div>';
  } else {
    projectList.innerHTML = [...projects.entries()].sort(([first], [second]) => first.localeCompare(second))
      .map(([name, count], index) => {
        const colors = ["project-symbol-sky", "project-symbol-peach", "project-symbol-lilac"];
        return `<div class="project-item">
          <div class="project-symbol ${colors[index % colors.length]}"><svg class="icon"><use href="#i-briefcase"/></svg></div>
          <div class="project-main"><h3>${escapeHtml(name)}</h3><p>${count} contractor${count === 1 ? "" : "s"} assigned</p></div>
        </div>`;
      }).join("");
  }
  document.querySelector("#project-summary-text").textContent = `${projects.size} job${projects.size === 1 ? "" : "s"} recorded for contractor compliance.`;
}

function renderContractorOptions() {
  const suggestions = document.querySelector("#contractor-suggestions");
  suggestions.innerHTML = contractors.map((contractor) =>
    `<option value="${escapeHtml(contractor.name)}">${escapeHtml(contractor.project)}</option>`
  ).join("");
  const purchasingContractor = document.querySelector("#purchasing-contractor");
  const selectedContractorId = purchasingContractor.value;
  purchasingContractor.innerHTML = '<option value="">Select a contractor</option>' + contractors.map((contractor) =>
    `<option value="${escapeHtml(contractor.id)}">${escapeHtml(contractor.name)} — ${escapeHtml(contractor.project || "Project not recorded")}</option>`
  ).join("");
  if (contractors.some(({ id }) => id === selectedContractorId)) purchasingContractor.value = selectedContractorId;
  renderPurchasing();
}

function renderPurchasing() {
  const selectedContractor = contractors.find(({ id }) =>
    id === document.querySelector("#purchasing-contractor").value,
  );
  const details = document.querySelector("#purchasing-contractor-details");
  if (!selectedContractor) {
    details.innerHTML = '<p>Select a contractor to see their profile and insurance documents.</p>';
  } else {
    const insuranceDocuments = documents.filter(({ contractorId, type }) =>
      contractorId === selectedContractor.id && type === "insurance",
    );
    const insuranceSection = insuranceDocuments.length
      ? `<div class="purchasing-insurance-list">${insuranceDocuments.map((insurance) => {
        const expiry = getExpiryStatus(insurance.expiryDate);
        return `<div class="purchasing-insurance-item">
          <span><strong>Insurance</strong><small>${escapeHtml(insurance.originalName)} · ${escapeHtml(expiry.text)}</small></span>
          <a class="text-button" href="/api/documents/${encodeURIComponent(insurance.id)}/download">Download copy</a>
        </div>`;
      }).join("")}</div>`
      : '<p class="purchasing-no-insurance">No insurance has been submitted for this contractor yet.</p>';
    details.innerHTML = `<div class="purchasing-profile-heading"><strong>${escapeHtml(selectedContractor.name)}</strong></div>
      <dl class="purchasing-profile-facts">
        <div><dt>Email</dt><dd>${escapeHtml(selectedContractor.email || "No email recorded")}</dd></div>
        <div><dt>Trade name</dt><dd>${escapeHtml(selectedContractor.trade || "Not recorded")}</dd></div>
        <div><dt>Project / job</dt><dd>${escapeHtml(selectedContractor.project || "Not recorded")}</dd></div>
        <div><dt>Site location</dt><dd>${escapeHtml(selectedContractor.site || "Unassigned")}</dd></div>
      </dl>
      <div class="purchasing-insurance"><h4>Submitted insurance</h4>${insuranceSection}</div>`;
  }

  const templateLink = document.querySelector("#supply-template-link");
  templateLink.innerHTML = purchasingTemplate
    ? `<span>Blank form: ${escapeHtml(purchasingTemplate.originalName)} · Uploaded ${escapeHtml(new Date(purchasingTemplate.uploadedAt).toLocaleDateString())}</span><a class="text-button" href="/api/purchasing/template/download">Download blank form</a>`
    : "No blank form has been uploaded yet.";

  renderPurchasingReview();
  renderFinanceReview();
  const list = document.querySelector("#purchasing-document-list");
  if (!purchasingDocuments.length) {
    list.innerHTML = '<div class="document-empty">Uploaded purchasing documents will appear here.</div>';
    return;
  }
  const labels = {
    registration: "Completed supply registration form",
    quotation: "Quotation",
    other: "Supplier document",
  };
  list.innerHTML = `<h3>Uploaded purchasing documents (${purchasingDocuments.length})</h3>${purchasingDocuments.map((item) => `
    <article class="purchasing-document-item">
      <span class="document-details"><strong>${escapeHtml(item.documentName)}</strong><span>${escapeHtml(labels[item.type] || "Purchasing document")} · ${escapeHtml(item.contractorName)} · ${escapeHtml(item.originalName)} · Uploaded ${escapeHtml(new Date(item.uploadedAt).toLocaleDateString())}</span></span>
      <a class="text-button" href="/api/purchasing/documents/${encodeURIComponent(item.id)}/download">Download</a>
    </article>`).join("")}`;
}

function renderPurchasingReview() {
  const contractorId = document.querySelector("#purchasing-contractor").value;
  const review = purchasingReviews.find(({ contractorId: id }) => id === contractorId);
  const form = document.querySelector("#purchasing-review-form");
  form.querySelector('[name="reviewerName"]').value = review?.reviewerName || "";
  form.querySelector('[name="approvalStatus"]').value = review?.approvalStatus || "";
  form.querySelector('[name="financeEmail"]').value = review?.financeEmail || "";
  form.querySelector('[name="projectOwnerEmail"]').value = review?.projectOwnerEmail || "";
  form.querySelector('[name="comments"]').value = review?.comments || "";
  form.querySelector('[type="submit"]').disabled = !contractorId;
  document.querySelector("#purchasing-review-updated").textContent = review?.updatedAt
    ? `Last saved ${new Date(review.updatedAt).toLocaleDateString()}`
    : "";
  renderPurchasingApprovalFields();
}

function renderPurchasingApprovalFields() {
  const form = document.querySelector("#purchasing-review-form");
  const approvalStatus = form.querySelector('[name="approvalStatus"]').value;
  const isApproved = approvalStatus === "Approved";
  const isRejected = approvalStatus === "Not approved";
  const financeField = form.querySelector("#purchasing-finance-email-field");
  financeField.hidden = !isApproved;
  financeField.querySelector("input").required = isApproved;
  const ownerField = form.querySelector("#purchasing-project-owner-email-field");
  ownerField.hidden = !isRejected;
  ownerField.querySelector("input").required = isRejected;
}

function renderFinanceWorkflowFields() {
  const form = document.querySelector("#finance-review-form");
  const purchasingReview = purchasingReviews.find(({ contractorId }) =>
    contractorId === document.querySelector("#purchasing-contractor").value,
  );
  const canDecide = purchasingReview?.approvalStatus === "Approved";
  const status = form.querySelector('[name="approvalStatus"]');
  form.querySelector('[name="financeEmail"]').required = canDecide;
  for (const option of status.options) {
    if (option.value !== "Pending") option.disabled = !canDecide;
  }
  if (!canDecide && status.value !== "Pending") status.value = "Pending";
  const isApproved = canDecide && status.value === "Approved";
  const isRejected = canDecide && status.value === "Not approved";
  const conditionalFields = [
    ["#health-safety-email-field", "healthSafetyEmail", isApproved],
    ["#project-engineer-email-field", "projectEngineerEmail", isApproved],
    ["#project-owner-email-field", "projectOwnerEmail", isRejected],
  ];
  for (const [selector, name, visible] of conditionalFields) {
    const field = form.querySelector(selector);
    field.hidden = !visible;
    field.querySelector(`[name="${name}"]`).required = visible;
  }
  const comments = form.querySelector('[name="comments"]');
  comments.required = isRejected;
  comments.placeholder = isRejected
    ? "Required: explain why the insurance was not approved"
    : "Add finance review comments";
  form.querySelector("#finance-comments-label").textContent = isRejected
    ? "Reason for rejection (saved with review)"
    : "Finance comments";
  document.querySelector("#finance-review-stage-note").textContent = canDecide
    ? "Email addresses and comments are saved with the review. No emails are sent."
    : "Finance decisions unlock after Purchasing approval. Email addresses and comments are saved only.";
}

function renderFinanceReview() {
  const contractorId = document.querySelector("#purchasing-contractor").value;
  const review = financeReviews.find(({ contractorId: id }) => id === contractorId);
  const purchasingReview = purchasingReviews.find(({ contractorId: id }) => id === contractorId);
  const form = document.querySelector("#finance-review-form");
  form.querySelector('[name="financeName"]').value = review?.financeName || "";
  form.querySelector('[name="financeEmail"]').value = purchasingReview?.financeEmail || review?.financeEmail || "";
  form.querySelector('[name="approvalStatus"]').value = review?.approvalStatus || "Pending";
  form.querySelector('[name="healthSafetyEmail"]').value = review?.healthSafetyEmail || "";
  form.querySelector('[name="projectEngineerEmail"]').value = review?.projectEngineerEmail || "";
  form.querySelector('[name="projectOwnerEmail"]').value = review?.projectOwnerEmail || "";
  form.querySelector('[name="comments"]').value = review?.comments || "";
  form.querySelector('[type="submit"]').disabled = !contractorId;
  document.querySelector("#finance-review-updated").textContent = review?.updatedAt
    ? `Last saved ${new Date(review.updatedAt).toLocaleDateString()}`
    : "";
  renderFinanceWorkflowFields();
}

function addSupplierDocumentEntry() {
  const index = nextSupplierDocumentIndex++;
  const entry = document.createElement("fieldset");
  entry.className = "supplier-document-entry";
  entry.dataset.supplierDocumentIndex = String(index);
  entry.innerHTML = `<legend>Supplier document ${index + 1}</legend>
    <label class="form-field"><span>Document name</span><input name="documentName_${index}" type="text" maxlength="120" placeholder="e.g. Product specification" required /></label>
    <label class="form-field"><span>Document file (PDF, JPG, or PNG; max 10 MB)</span><input name="file_${index}" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" required /></label>
    <button class="button button-secondary remove-supplier-document" type="button" data-remove-supplier-document>Remove document</button>`;
  document.querySelector("#supplier-other-document-entries").append(entry);
}

function nextCertificateIndex() {
  const usedIndexes = new Set([...document.querySelectorAll(".certificate-entry")]
    .map((entry) => Number(entry.dataset.certificateIndex)));
  let index = 0;
  while (usedIndexes.has(index)) index += 1;
  return index;
}

function addCertificationToCrew(crewIndex) {
  const certificateEntries = document.querySelectorAll(".certificate-entry");
  if (certificateEntries.length >= maxCertificates) {
    showToast(`You can add up to ${maxCertificates} certifications in one submission.`);
    return;
  }
  const certificateIndex = nextCertificateIndex();
  const certificateList = document.querySelector(`.crew-cert-list[data-crew-index="${crewIndex}"]`);
  const certificateNumber = certificateList.querySelectorAll(".certificate-entry").length + 1;
  const entry = document.createElement("fieldset");
  entry.className = "certificate-entry";
  entry.dataset.certificateIndex = String(certificateIndex);
  entry.innerHTML = `<legend>Certification ${certificateNumber}</legend>
    <input type="hidden" name="certificateCrew_${certificateIndex}" value="${crewIndex}" />
    <label class="form-field"><span>Certification name</span><input name="certificateName_${certificateIndex}" type="text" maxlength="120" placeholder="e.g. Confined space entry" required /></label>
    <label class="form-field"><span>Expiry date</span><input name="certificateExpiryDate_${certificateIndex}" type="date" required /></label>
    <label class="form-field"><span>Upload file (PDF, JPG, PNG; max 10 MB)</span><input name="certificate_${certificateIndex}" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" required /></label>
    <button class="button button-secondary remove-certificate" type="button" data-remove-certificate aria-label="Remove certification">Remove</button>`;
  certificateList.append(entry);
}

function addCrewEntry() {
  const crews = document.querySelectorAll(".crew-entry");
  if (crews.length >= maxCrews) {
    showToast(`You can add up to ${maxCrews} crew members in one submission.`);
    return;
  }
  if (document.querySelectorAll(".certificate-entry").length >= maxCertificates) {
    showToast(`You can add up to ${maxCertificates} certifications in one submission.`);
    return;
  }
  const usedIndexes = new Set([...crews].map((crew) => Number(crew.dataset.crewIndex)));
  let crewIndex = 0;
  while (usedIndexes.has(crewIndex)) crewIndex += 1;
  const crew = document.createElement("fieldset");
  crew.className = "crew-entry";
  crew.dataset.crewIndex = String(crewIndex);
  crew.innerHTML = `<legend>Crew ${crewIndex + 1}</legend>
    <label class="form-field"><span>Crew name</span><input name="crewName_${crewIndex}" type="text" maxlength="80" placeholder="Type crew member name" required /></label>
    <div class="crew-cert-list" data-crew-index="${crewIndex}"></div>
    <button class="button button-secondary add-crew-certificate" type="button" data-add-crew-certificate="${crewIndex}"><svg class="icon"><use href="#i-plus"/></svg>Add certification</button>
    <button class="button button-secondary remove-crew" type="button" data-remove-crew aria-label="Remove crew">Remove crew</button>`;
  document.querySelector("#crew-list").append(crew);
  addCertificationToCrew(crewIndex);
}

function resetCrewEntries() {
  document.querySelectorAll("#crew-list .crew-entry:not([data-crew-index='0'])").forEach((entry) => entry.remove());
  document.querySelectorAll("#crew-list .certificate-entry:not([data-certificate-index='0'])").forEach((entry) => entry.remove());
}

function renderDocuments() {
  const list = document.querySelector("#document-list");
  document.querySelector("#document-total").textContent = String(documents.length);
  renderExpiryAlerts();
  if (!documents.length) {
    list.innerHTML = '<div class="document-empty">No submissions yet. Uploaded files will appear here.</div>';
    document.querySelector("#activity-list").innerHTML = '<div class="activity-empty">Submitted documents will appear here.</div>';
    return;
  }
  list.innerHTML = documents.map((document) => {
    const type = documentTypes.find(({ value }) => value === document.type);
    const expiry = getExpiryStatus(document.expiryDate);
    const job = document.jobName ? ` · ${escapeHtml(document.jobName)}` : "";
    const crew = document.crewName ? ` · ${escapeHtml(document.crewName)}` : "";
    const owner = document.projectOwnerName
      ? `<span>Project owner: ${escapeHtml(document.projectOwnerName)} · ${escapeHtml(document.projectOwnerPhone)} · ${escapeHtml(document.projectOwnerEmail)}</span>`
      : "";
    const permitRequirements = document.permitsRequired
      ? `<span class="document-permits">Permits: ${escapeHtml(document.permitsRequired)}</span>`
      : "";
    return `<article class="submitted-document">
      <span class="document-icon"><svg class="icon"><use href="#i-file"/></svg></span>
      <span class="document-details"><strong>${escapeHtml(type.label)}${crew}${job}</strong><span>${escapeHtml(document.contractorName)} · ${escapeHtml(document.areaLocation)} · ${escapeHtml(document.originalName)}</span>${owner}${permitRequirements}</span>
      <span class="expiry-status ${expiry.className}">${escapeHtml(expiry.text)}</span>
      <a class="text-button" href="/api/documents/${encodeURIComponent(document.id)}/download">Download</a>
    </article>`;
  }).join("");
  document.querySelector("#activity-list").innerHTML = documents.slice(0, 4).map((document) => {
    const type = documentTypes.find(({ value }) => value === document.type);
    const initials = document.contractorName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    const details = [type.label, document.crewName, document.jobName].filter(Boolean).join(" · ");
    return `<div class="activity-item">
      <div class="activity-avatar avatar-mint">${escapeHtml(initials)}</div>
      <div class="activity-copy"><p><strong>${escapeHtml(document.contractorName)}</strong> submitted a document</p>
      <span>${escapeHtml(details)} · ${new Date(document.uploadedAt).toLocaleDateString()}</span></div>
      <span class="activity-file"><svg class="icon"><use href="#i-file"/></svg></span>
    </div>`;
  }).join("");
}

document.querySelector("#add-crew").addEventListener("click", addCrewEntry);
document.querySelector("#crew-list").addEventListener("click", (event) => {
  const addButton = event.target.closest("[data-add-crew-certificate]");
  if (addButton) addCertificationToCrew(addButton.dataset.addCrewCertificate);
  const removeButton = event.target.closest("[data-remove-certificate]");
  if (removeButton) {
    const certificateList = removeButton.closest(".crew-cert-list");
    const crew = removeButton.closest(".crew-entry");
    removeButton.closest(".certificate-entry").remove();
    if (!certificateList.querySelector(".certificate-entry") && crew.dataset.crewIndex !== "0") crew.remove();
  }
  const removeCrewButton = event.target.closest("[data-remove-crew]");
  if (removeCrewButton) removeCrewButton.closest(".crew-entry").remove();
});

const permitInputs = [...permitForm.querySelectorAll('input[name="permitTypes"]')];
const otherPermitInput = permitForm.querySelector('input[name="permitOther"]');
const otherPermitField = permitForm.querySelector("#permit-other-field");
const permitScheduleList = document.querySelector("#permit-schedule-list");
function validatePermitScheduleDates() {
  permitScheduleList.querySelectorAll(".permit-schedule-entry").forEach((entry) => {
    const startInput = entry.querySelector('input[name^="permitStart_"]');
    const endInput = entry.querySelector('input[name^="permitEnd_"]');
    endInput.min = startInput.value;
    const startAt = startInput.value ? new Date(startInput.value).getTime() : Number.NaN;
    const endAt = endInput.value ? new Date(endInput.value).getTime() : Number.NaN;
    endInput.setCustomValidity(Number.isFinite(startAt) && Number.isFinite(endAt) && endAt <= startAt
      ? "End date and time must be after the start date and time."
      : "");
  });
}
function syncPermitInputs() {
  const hasPermit = permitInputs.some((input) => input.checked);
  permitInputs[0].setCustomValidity(hasPermit ? "" : "Select at least one permit.");
  const selected = new Set(permitInputs.filter((input) => input.checked).map(({ dataset }) => dataset.permitIndex));
  permitScheduleList.querySelectorAll(".permit-schedule-entry").forEach((entry) => {
    if (!selected.has(entry.dataset.permitIndex)) entry.remove();
  });
  permitInputs.filter((input) => input.checked).forEach((input) => {
    const index = input.dataset.permitIndex;
    if (permitScheduleList.querySelector(`[data-permit-index="${index}"]`)) return;
    const entry = document.createElement("fieldset");
    entry.className = "permit-schedule-entry";
    entry.dataset.permitIndex = index;
    entry.innerHTML = `<legend>${escapeHtml(input.value)} schedule</legend>
      <label class="form-field"><span>Start date &amp; time</span><input name="permitStart_${index}" type="datetime-local" required /></label>
      <label class="form-field"><span>End date &amp; time</span><input name="permitEnd_${index}" type="datetime-local" required /></label>
      ${input.value === "Hot work permit" ? `<div class="permit-responsibility-fields">
        <label class="form-field"><span>Person in charge — name</span><input name="permitContactName_${index}" type="text" maxlength="80" required /></label>
        <label class="form-field"><span>Person in charge — email address</span><input name="permitContactEmail_${index}" type="email" maxlength="120" required /></label>
        <label class="form-field"><span>Health &amp; Safety issuer name</span><input name="permitIssuerName_${index}" type="text" maxlength="80" required /></label>
      </div>` : ""}`;
    permitScheduleList.append(entry);
  });
  const needsOtherDetails = permitForm.querySelector('input[name="permitTypes"][value="Other"]').checked;
  otherPermitField.hidden = !needsOtherDetails;
  otherPermitInput.required = needsOtherDetails;
  if (!needsOtherDetails) otherPermitInput.value = "";
  validatePermitScheduleDates();
}
permitInputs.forEach((input) => input.addEventListener("change", syncPermitInputs));
permitScheduleList.addEventListener("input", validatePermitScheduleDates);
permitForm.addEventListener("reset", () => window.setTimeout(syncPermitInputs, 0));
syncPermitInputs();

function createDocumentSubmission() {
  return new FormData(documentForm);
}

function createPermitSubmission() {
  const formData = new FormData(permitForm);
  if (!permitForm.querySelector('input[name="permitDocument"]').files.length) {
    formData.delete("permitDocument");
  }
  permitInputs.filter((input) => input.checked).forEach(({ dataset }) => {
    for (const suffix of ["Start", "End"]) {
      const field = `permit${suffix}_${dataset.permitIndex}`;
      const localDateTime = formData.get(field);
      if (typeof localDateTime !== "string" || !localDateTime) {
        throw new Error("Enter a valid start and end date/time for every permit.");
      }
      const date = new Date(localDateTime);
      if (!Number.isFinite(date.getTime())) {
        throw new Error("Enter a valid start and end date/time for every permit.");
      }
      formData.set(field, date.toISOString());
    }
  });
  return formData;
}

async function loadData() {
  const [contractorData, documentData, permitData, purchasingDocumentData, templateData, purchasingReviewData, financeReviewData] = await Promise.all([
    apiRequest("/api/contractors"),
    apiRequest("/api/documents"),
    apiRequest("/api/permits"),
    apiRequest("/api/purchasing/documents"),
    apiRequest("/api/purchasing/template"),
    apiRequest("/api/purchasing/reviews"),
    apiRequest("/api/finance/reviews"),
  ]);
  contractors.splice(0, contractors.length, ...contractorData);
  documents = documentData;
  permits = permitData;
  purchasingDocuments = purchasingDocumentData;
  purchasingTemplate = templateData;
  purchasingReviews = purchasingReviewData;
  financeReviews = financeReviewData;
  renderContractorOptions();
  renderContractors();
  renderDocuments();
  renderPermits();
}

contractorSearch.addEventListener("input", renderContractors);
statusFilter.addEventListener("change", renderContractors);
document.querySelector("#approved-site-filter").addEventListener("change", renderApprovedContractors);
document.querySelector("#purchasing-contractor").addEventListener("change", renderPurchasing);
document.querySelector("#purchasing-review-form [name=\"approvalStatus\"]")
  .addEventListener("change", renderPurchasingApprovalFields);
document.querySelector("#finance-review-form [name=\"approvalStatus\"]")
  .addEventListener("change", renderFinanceWorkflowFields);
document.querySelector("#global-search").addEventListener("input", (event) => {
  contractorSearch.value = event.target.value;
  renderContractors();
  if (event.target.value) document.querySelector("#contractors").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.querySelector("#export-button").addEventListener("click", () => {
  const headers = ["Name", "Email", "Site location", "Trade name", "Project", "Status", "Documents", "Created"];
  const csv = [headers, ...contractors.map((contractor) => [
    contractor.name, contractor.email, contractor.site || "Unassigned", contractor.trade, contractor.project,
    contractor.status, documentSummary(contractor.id), contractor.createdAt,
  ])]
    .map((row) => row.map((field) => `"${String(field).replaceAll('"', '""')}"`).join(","))
    .join("\r\n");
  const link = document.createElement("a");
  const downloadUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.href = downloadUrl;
  link.download = "tricel-contractors.csv";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  showToast("Contractor list exported.");
});

document.querySelector("#add-contractor").addEventListener("click", () => dialog.showModal());
document.querySelector("#dialog-close").addEventListener("click", () => dialog.close());
document.querySelector("#cancel-dialog").addEventListener("click", () => dialog.close());
document.querySelector("#pending-documents-card").addEventListener("click", () => {
  renderPendingDocuments();
  pendingDocumentsDialog.showModal();
});
document.querySelector("#pending-documents-close").addEventListener("click", () => pendingDocumentsDialog.close());
pendingDocumentsDialog.addEventListener("click", (event) => {
  if (event.target === pendingDocumentsDialog) pendingDocumentsDialog.close();
});
document.querySelector("#contractor-details-close").addEventListener("click", () => contractorDetailsDialog.close());
contractorDetailsDialog.addEventListener("click", (event) => {
  if (event.target === contractorDetailsDialog) contractorDetailsDialog.close();
});
const contractorProfileContent = document.querySelector("#contractor-profile-content");
contractorProfileContent.addEventListener("change", (event) => {
  const form = event.target.closest("form[data-contractor-review], form[data-document-review]");
  if (!form) return;
  const isContractorReview = form.matches("[data-contractor-review]");
  const statusField = form.querySelector(`[name="${isContractorReview ? "approvalStatus" : "verificationStatus"}"]`);
  const reviewerField = form.querySelector(`[name="${isContractorReview ? "approvedBy" : "verifiedBy"}"]`);
  reviewerField.required = statusField.value === (isContractorReview ? "Approved" : "Verified");
});
contractorProfileContent.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-contractor-review], form[data-document-review]");
  if (!form) return;
  event.preventDefault();
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(form));
    if (form.matches("[data-contractor-review]")) {
      const contractorId = form.dataset.contractorId;
      const updatedContractor = await apiRequest(`/api/contractors/${encodeURIComponent(contractorId)}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const index = contractors.findIndex(({ id }) => id === contractorId);
      if (index >= 0) contractors[index] = updatedContractor;
      renderContractors();
      renderContractorDetails(contractorId);
      showToast("Contractor review saved.");
    } else {
      const documentId = form.dataset.documentId;
      const updatedDocument = await apiRequest(`/api/documents/${encodeURIComponent(documentId)}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const index = documents.findIndex(({ id }) => id === documentId);
      if (index >= 0) documents[index] = updatedDocument;
      renderContractorDetails(updatedDocument.contractorId);
      showToast("Document review saved.");
    }
  } catch (error) {
    showToast(error.message);
    submitButton.disabled = false;
  }
});
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
contractorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = contractorForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const formData = new FormData(contractorForm);
    const contractor = await apiRequest("/api/contractors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(formData)),
    });
    contractors.unshift(contractor);
    contractorForm.reset();
    statusFilter.value = "all";
    contractorSearch.value = "";
    document.querySelector("#global-search").value = "";
    renderContractorOptions();
    renderContractors();
    dialog.close();
    showToast(`${contractor.name} has been added.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

documentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = document.querySelector("#submit-document");
  submitButton.disabled = true;
  try {
    await apiRequest("/api/documents", {
      method: "POST",
      body: createDocumentSubmission(),
    });
    documentForm.reset();
    resetCrewEntries();
    await loadData();
    showToast("Document submitted successfully.");
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#supply-template-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    await apiRequest("/api/purchasing/template", {
      method: "POST",
      body: new FormData(form),
    });
    form.reset();
    await loadData();
    showToast("Supply registration form uploaded.");
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#add-supplier-document").addEventListener("click", addSupplierDocumentEntry);
document.querySelector("#supplier-other-document-entries").addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-remove-supplier-document]");
  if (removeButton) removeButton.closest(".supplier-document-entry").remove();
});

document.querySelector("#purchasing-requirements").addEventListener("submit", async (event) => {
  const form = event.target.closest(".purchasing-document-form");
  if (!form) return;
  event.preventDefault();
  const contractorId = document.querySelector("#purchasing-contractor").value;
  if (!contractorId) {
    showToast("Select a contractor before uploading a purchasing document.");
    return;
  }
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  let uploadedCount = 0;
  try {
    if (form.dataset.purchasingType === "other") {
      const entries = [...form.querySelectorAll(".supplier-document-entry")];
      const failedNames = [];
      for (const entry of entries) {
        const nameInput = entry.querySelector('input[name^="documentName_"]');
        const fileInput = entry.querySelector('input[name^="file_"]');
        const formData = new FormData();
        formData.set("contractorId", contractorId);
        formData.set("type", "other");
        formData.set("documentName", nameInput.value);
        formData.set("file", fileInput.files[0]);
        try {
          await apiRequest("/api/purchasing/documents", { method: "POST", body: formData });
          uploadedCount += 1;
          if (entry.dataset.supplierDocumentIndex === "0") {
            nameInput.value = "";
            fileInput.value = "";
          } else {
            entry.remove();
          }
        } catch (error) {
          failedNames.push(`${nameInput.value}: ${error.message}`);
        }
      }
      if (uploadedCount) await loadData();
      if (failedNames.length) {
        showToast(`${uploadedCount} uploaded; ${failedNames.length} failed: ${failedNames[0]}`);
      } else {
        showToast(`${uploadedCount} supplier document${uploadedCount === 1 ? "" : "s"} uploaded.`);
      }
      return;
    }

    const formData = new FormData(form);
    formData.set("contractorId", contractorId);
    await apiRequest("/api/purchasing/documents", { method: "POST", body: formData });
    form.reset();
    await loadData();
    showToast("Purchasing document uploaded.");
  } catch (error) {
    showToast(uploadedCount
      ? `${uploadedCount} documents uploaded; refresh failed: ${error.message}`
      : error.message);
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#purchasing-review-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const contractorId = document.querySelector("#purchasing-contractor").value;
  if (!contractorId) {
    showToast("Select a contractor before saving a purchasing review.");
    return;
  }
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const review = await apiRequest(`/api/purchasing/reviews/${encodeURIComponent(contractorId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const index = purchasingReviews.findIndex(({ contractorId: id }) => id === review.contractorId);
    if (index >= 0) purchasingReviews[index] = review;
    else purchasingReviews.push(review);
    renderPurchasingReview();
    renderFinanceReview();
    showToast("Purchasing review saved. No email was sent.");
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = !document.querySelector("#purchasing-contractor").value;
  }
});

document.querySelector("#finance-review-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const contractorId = document.querySelector("#purchasing-contractor").value;
  if (!contractorId) {
    showToast("Select a contractor before assigning a finance reviewer.");
    return;
  }
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const review = await apiRequest(`/api/finance/reviews/${encodeURIComponent(contractorId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const index = financeReviews.findIndex(({ contractorId: id }) => id === review.contractorId);
    if (index >= 0) financeReviews[index] = review;
    else financeReviews.push(review);
    renderFinanceReview();
    showToast("Finance review saved. No email was sent.");
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = !document.querySelector("#purchasing-contractor").value;
  }
});

permitForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = document.querySelector("#submit-permit");
  submitButton.disabled = true;
  try {
    await apiRequest("/api/permits", {
      method: "POST",
      body: createPermitSubmission(),
    });
    permitForm.reset();
    await loadData();
    showToast("Permit submitted successfully.");
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

document.addEventListener("click", (event) => {
  const toastButton = event.target.closest("[data-toast]");
  if (toastButton) showToast(toastButton.dataset.toast);
  const profileButton = event.target.closest("[data-view-contractor]");
  if (profileButton) {
    renderContractorDetails(profileButton.dataset.viewContractor);
    return;
  }
  const rowButton = event.target.closest("[data-contractor]");
  if (rowButton) {
    const contractor = contractors.find(({ id }) => id === rowButton.dataset.contractor);
    if (contractor) document.querySelector("#document-contractor-name").value = contractor.name;
    document.querySelector("#documents").scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

document.querySelector("#notification-button").addEventListener("click", () => showToast("You’re all caught up on notifications."));
document.querySelector("#current-date").textContent = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
}).format(new Date()).toUpperCase();

const sidebar = document.querySelector("#sidebar");
const sidebarScrim = document.querySelector("#sidebar-scrim");
function closeSidebar() {
  sidebar.classList.remove("is-open");
  sidebarScrim.classList.remove("is-open");
}
document.querySelector("#mobile-menu").addEventListener("click", () => {
  sidebar.classList.add("is-open");
  sidebarScrim.classList.add("is-open");
});
sidebarScrim.addEventListener("click", closeSidebar);
sidebar.querySelectorAll(".nav-link, .nav-sub-link").forEach((link) => link.addEventListener("click", closeSidebar));

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.querySelector("#global-search").focus();
  }
});

loadData().catch((error) => showToast(`Could not load workspace: ${error.message}`));
