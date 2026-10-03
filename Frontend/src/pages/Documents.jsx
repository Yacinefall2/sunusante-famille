import { useEffect, useRef, useState } from "react";
import { AppShell } from "../components/layout/AppShell";
import { useFamily } from "../context/FamilyContext";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Input, Textarea, Select } from "../components/ui/Input";
import { MemberAvatar } from "../components/members/MemberAvatar";
import {
  Plus,
  Trash2,
  Loader2,
  FileText,
  Clock,
  Tag,
  ExternalLink,
  UploadCloud,
  X,
  Pencil,
  Eye,
  EyeOff,
} from "lucide-react";
import { formatDateTime, DOCUMENT_TYPES } from "../lib/utils";
import toast from "react-hot-toast";

const defaultForm = {
  memberId: "",
  title: "",
  documentType: "ordonnance",
  description: "",
};

const docTypeIcons = {
  ordonnance: "💊",
  resultat: "🔬",
  radio: "🩻",
  "compte-rendu": "📋",
  autre: "📄",
};

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 Mo — doit correspondre à la limite backend
const ACCEPTED_TYPES = ".pdf,.jpg,.jpeg,.png,.webp,.heic,.doc,.docx";

const isImageFile = (url) => {
  if (!url) return false;
  const ext = url.split(".").pop()?.toLowerCase();
  return ["jpg", "jpeg", "png", "webp", "gif", "heic"].includes(ext);
};

const isPdfFile = (url) => {
  if (!url) return false;
  const ext = url.split(".").pop()?.toLowerCase();
  return ext === "pdf";
};

export default function DocumentsPage() {
  // Fiches de la famille issues du contexte, avec le niveau d'accès de
  // l'utilisateur : on ne consulte que les dossiers lisibles, et on n'ajoute /
  // modifie / supprime que sur ceux en accès complet.
  const { selectedFamily, members: allMembers, writableMembers, canWriteMember, canReadMember } = useFamily();
  const members = allMembers.filter((m) => canReadMember(m.id));
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(defaultForm);
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [showPreview, setShowPreview] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const fileInputRef = useRef(null);

  const [stepMember, setStepMember] = useState(null);
  const [stepType, setStepType] = useState(null);

  useEffect(() => {
    if (selectedFamily) {
      load();
    }
    setStepMember(null);
    setStepType(null);
  }, [selectedFamily]);

  useEffect(() => {
    setShowPreview(true);
    setPreviewLoading(false);
  }, [viewing]);

  const load = async () => {
    if (!selectedFamily) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/documents?familyId=${selectedFamily.id}`);
      const data = await res.json();

      if (res.ok && Array.isArray(data)) {
        setDocs(data);
      } else {
        setDocs([]);
        toast.error(data?.error || "Erreur lors du chargement des documents");
      }
    } catch (err) {
      setDocs([]);
      toast.error("Erreur lors du chargement des documents");
    } finally {
      setLoading(false);
    }
  };

  const openAdd = () => {
    setEditing(null);

    // Membre présélectionné : celui de l'étape en cours s'il est modifiable,
    // sinon la première fiche modifiable.
    const preselectedMemberId =
      stepMember && stepMember !== "all" && canWriteMember(stepMember)
        ? stepMember
        : writableMembers[0]?.id?.toString() ?? "";

    const preselectedType =
      stepType && stepType !== "all"
        ? stepType
        : defaultForm.documentType;

    setForm({
      ...defaultForm,
      memberId: preselectedMemberId,
      documentType: preselectedType,
    });

    setFile(null);
    setShowForm(true);
  };

  const resetSteps = () => {
    setStepMember(null);
    setStepType(null);
  };

  const openEditDoc = (doc) => {
    setEditing(doc);

    setForm({
      memberId: doc.memberId.toString(),
      title: doc.title,
      documentType: doc.documentType,
      description: doc.description ?? "",
    });

    setFile(null);
    setViewing(null);
    setShowForm(true);
  };

  const handleFileChange = (e) => {
    const selected = e.target.files?.[0];

    if (!selected) return;

    if (selected.size > MAX_FILE_SIZE) {
      toast.error("Le fichier dépasse la taille maximale de 15 Mo");
      e.target.value = "";
      return;
    }

    setFile(selected);
  };

  const removeFile = () => {
    setFile(null);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const save = async () => {
    if (!form.memberId || !form.title.trim() || !form.documentType) {
      toast.error("Champs requis manquants");
      return;
    }

    setSaving(true);

    try {
      if (editing) {
        const res = await fetch("/api/documents", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: editing.id,
            title: form.title.trim(),
            documentType: form.documentType,
            description: form.description || "",
          }),
        });

        if (res.ok) {
          toast.success("Document modifié !");
          setShowForm(false);
          setEditing(null);
          setFile(null);
          load();
        } else {
          const err = await res.json().catch(() => ({}));

          toast.error(
            err.error || "Erreur lors de la modification du document"
          );
        }
      } else {
        const body = new FormData();

        body.append("memberId", form.memberId);
        body.append("title", form.title.trim());
        body.append("documentType", form.documentType);
        body.append("description", form.description || "");

        if (file) {
          body.append("file", file);
        }

        const res = await fetch("/api/documents", {
          method: "POST",
          body,
        });

        if (res.ok) {
          toast.success("Document ajouté !");
          setShowForm(false);
          setFile(null);
          load();
        } else {
          const err = await res.json().catch(() => ({}));

          toast.error(
            err.error || "Erreur lors de l'ajout du document"
          );
        }
      }
    } finally {
      setSaving(false);
    }
  };

  // Suppression (depuis la carte ou le détail) — refusée par le serveur si
  // l'utilisateur n'a pas l'accès complet au dossier.
  const removeDoc = async (id) => {
    if (
      !confirm(
        "Supprimer ce document ? Le fichier associé sera aussi supprimé."
      )
    ) {
      return false;
    }

    const res = await fetch(`/api/documents?id=${id}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Erreur lors de la suppression");
      return false;
    }

    toast.success("Supprimé");
    load();
    return true;
  };

  const deleteDoc = async (id) => {
    if (await removeDoc(id)) setViewing(null);
  };

  const deleteDocFromCard = (id) => removeDoc(id);

  const f = (key) => (e) =>
    setForm((p) => ({
      ...p,
      [key]: e.target.value,
    }));

  const getMember = (id) =>
    members.find((m) => m.id === id);

  const getDocTypeLabel = (type) =>
    DOCUMENT_TYPES.find((d) => d.value === type)?.label ?? type;

  let filtered = docs;

  if (stepType && stepType !== "all") {
    filtered = filtered.filter(
      (d) => d.documentType === stepType
    );
  }

  if (stepMember && stepMember !== "all") {
    filtered = filtered.filter(
      (d) => d.memberId.toString() === stepMember
    );
  }

  const stepMemberLabel =
    stepMember === "all"
      ? "Tous les membres"
      : getMember(parseInt(stepMember))?.firstName ?? "";

  const stepTypeLabel =
    stepType === "all"
      ? "Tous les types"
      : getDocTypeLabel(stepType);

  const docTypeColor = {
    ordonnance: "bg-purple-50 text-purple-700",
    resultat: "bg-blue-50 text-blue-700",
    radio: "bg-cyan-50 text-cyan-700",
    "compte-rendu": "bg-green-50 text-green-700",
    autre: "bg-gray-50 text-gray-700",
  };

  if (!selectedFamily) {
    return (
      <AppShell>
        <div className="text-center py-20 text-gray-400">
          <FileText
            size={48}
            className="mx-auto mb-3 opacity-30"
          />

          <p className="text-lg font-medium">
            Aucune famille sélectionnée
          </p>
        </div>
      </AppShell>
    );
  }

  const viewedMember = viewing
    ? getMember(viewing.memberId)
    : null;

  const isViewingImage = viewing
    ? isImageFile(viewing.fileUrl)
    : false;

  const isViewingPdf = viewing
    ? isPdfFile(viewing.fileUrl)
    : false;

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-800">
              Documents — {selectedFamily.name}
            </h2>

            <p className="text-sm text-gray-500">
              {docs.length} document(s) stocké(s)
            </p>
          </div>

          {writableMembers.length > 0 && (
            <Button onClick={openAdd}>
              <Plus size={16} />
              Ajouter un document
            </Button>
          )}
        </div>

        {members.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-16 text-center">
            <div className="w-20 h-20 bg-violet-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <FileText
                size={36}
                className="text-violet-400"
              />
            </div>

            <h3 className="text-lg font-bold text-gray-700 mb-2">
              Aucun document pour le moment
            </h3>

            <p className="text-gray-400 mb-6">
              Stockez ordonnances, résultats d'analyses et comptes-rendus médicaux.
            </p>

            <p className="text-sm text-amber-600 bg-amber-50 px-4 py-2 rounded-xl inline-block">
              ⚠️ Ajoutez d'abord un membre depuis la page Membres
            </p>
          </div>
        ) : stepMember === null ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 sm:p-10 text-center">
            <div className="w-20 h-20 bg-violet-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <FileText
                size={36}
                className="text-violet-400"
              />
            </div>

            <h3 className="text-lg font-bold text-gray-700 mb-2">
              Quel membre souhaitez-vous consulter ?
            </h3>

            <p className="text-gray-400 mb-6">
              Choisissez le membre concerné pour voir ses documents.
            </p>

            <div className="flex flex-wrap justify-center gap-2 max-w-md mx-auto">
              {members.map((m) => (
                <button
                  key={m.id}
                  onClick={() =>
                    setStepMember(m.id.toString())
                  }
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium border bg-white text-gray-600 border-gray-200 hover:border-violet-300 transition-all"
                >
                  <MemberAvatar
                    member={m}
                    size="sm"
                  />

                  {m.firstName}
                </button>
              ))}

              <button
                onClick={() => setStepMember("all")}
                className="px-3 py-1.5 rounded-full text-sm font-medium border border-dashed border-gray-300 text-gray-500 hover:border-violet-300 hover:text-violet-600 transition-all"
              >
                Tous les membres
              </button>
            </div>
          </div>
        ) : stepType === null ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 sm:p-10 text-center">
            <div className="w-20 h-20 bg-violet-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <FileText
                size={36}
                className="text-violet-400"
              />
            </div>

            <h3 className="text-lg font-bold text-gray-700 mb-2">
              Quel type de document ?
            </h3>

            <p className="text-gray-400 mb-6">
              Pour{" "}
              <span className="font-semibold text-gray-600">
                {stepMemberLabel}
              </span>
              , choisissez le type de document à consulter.
            </p>

            <div className="flex flex-wrap justify-center gap-2 max-w-md mx-auto">
              {DOCUMENT_TYPES.map((dt) => (
                <button
                  key={dt.value}
                  onClick={() => setStepType(dt.value)}
                  className="px-3 py-1.5 rounded-full text-xs font-medium bg-white text-gray-600 border border-gray-200 hover:border-teal-300 transition-all"
                >
                  {docTypeIcons[dt.value]} {dt.label}
                </button>
              ))}

              <button
                onClick={() => setStepType("all")}
                className="px-3 py-1.5 rounded-full text-xs font-medium border border-dashed border-gray-300 text-gray-500 hover:border-teal-300 hover:text-teal-600 transition-all"
              >
                Tous les types
              </button>
            </div>

            <button
              onClick={() => setStepMember(null)}
              className="mt-6 text-xs font-medium text-gray-400 hover:text-gray-600 underline"
            >
              ← Changer de membre
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
              <span>
                Documents de{" "}
                <span className="font-semibold text-gray-700">
                  {stepMemberLabel}
                </span>{" "}
                · {stepTypeLabel}
              </span>

              <button
                onClick={resetSteps}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-white border border-gray-200 text-gray-600 hover:border-violet-300 hover:text-violet-600 transition-colors"
              >
                Changer la sélection
              </button>
            </div>

            {loading ? (
              <div className="flex justify-center py-20">
                <Loader2
                  className="animate-spin text-teal-600"
                  size={36}
                />
              </div>
            ) : filtered.length === 0 ? (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-16 text-center">
                <div className="w-20 h-20 bg-violet-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <FileText
                    size={36}
                    className="text-violet-400"
                  />
                </div>

                <h3 className="text-lg font-bold text-gray-700 mb-2">
                  Aucun document ne correspond
                </h3>

                <p className="text-gray-400 mb-6">
                  Aucun document pour {stepMemberLabel} · {stepTypeLabel}.
                </p>

                {writableMembers.length > 0 && (
                  <Button onClick={openAdd}>
                    <Plus size={16} />
                    Ajouter ce document
                  </Button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {filtered.map((doc) => {
                  const member = getMember(doc.memberId);
                  const icon =
                    docTypeIcons[doc.documentType] ?? "📄";

                  const colorClass =
                    docTypeColor[doc.documentType] ??
                    "bg-gray-50 text-gray-700";

                  return (
                    <div
                      key={doc.id}
                      onClick={() => setViewing(doc)}
                      className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 hover:shadow-md transition-all duration-200 flex flex-col cursor-pointer"
                      title="Cliquez pour voir les détails"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div
                          className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl ${colorClass}`}
                        >
                          {icon}
                        </div>

                        <div
                          className="flex items-center gap-1"
                          onClick={(e) =>
                            e.stopPropagation()
                          }
                        >
                          {doc.fileUrl && (
                            <a
                              href={doc.fileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-teal-600 transition-colors"
                              title="Ouvrir le fichier"
                            >
                              <ExternalLink size={14} />
                            </a>
                          )}

                          {canWriteMember(doc.memberId) && (
                            <button
                              onClick={() =>
                                deleteDocFromCard(doc.id)
                              }
                              className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>

                      <h3 className="font-bold text-gray-800 text-sm mb-1 line-clamp-2">
                        {doc.title}
                      </h3>

                      <div className="flex flex-wrap gap-1.5 mb-2">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1 ${colorClass}`}
                        >
                          <Tag size={10} />
                          {getDocTypeLabel(
                            doc.documentType
                          )}
                        </span>
                      </div>

                      {doc.description && (
                        <p className="text-xs text-gray-500 mb-1 line-clamp-2 italic">
                          {doc.description}
                        </p>
                      )}

                      {doc.originalName && (
                        <p className="text-xs text-gray-400 mb-3 truncate flex items-center gap-1">
                          <FileText size={11} />{" "}
                          {doc.originalName}
                        </p>
                      )}

                      <div className="mt-auto pt-3 border-t border-gray-50 flex items-center justify-between">
                        {member && (
                          <MemberAvatar
                            member={member}
                            size="sm"
                            showName
                          />
                        )}

                        <span className="text-xs text-gray-400 flex items-center gap-1">
                          <Clock size={10} />
                          {formatDateTime(
                            doc.uploadedAt
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        title="Détails du document"
        size="lg"
      >
        {viewing && (
          <div className="space-y-6">
            <div className="bg-gradient-to-r from-violet-50 to-purple-50 rounded-2xl p-5 border border-violet-100">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-4">
                  <div
                    className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl flex-shrink-0 ${
                      docTypeColor[
                        viewing.documentType
                      ] ?? "bg-gray-50"
                    }`}
                  >
                    {docTypeIcons[
                      viewing.documentType
                    ] ?? "📄"}
                  </div>

                  <div>
                    <h3 className="text-lg font-bold text-gray-800">
                      {viewing.title}
                    </h3>

                    <span
                      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium mt-1 ${
                        docTypeColor[
                          viewing.documentType
                        ] ??
                        "bg-gray-50 text-gray-700"
                      }`}
                    >
                      <Tag size={10} />
                      {getDocTypeLabel(
                        viewing.documentType
                      )}
                    </span>
                  </div>
                </div>

                {viewing.fileUrl && (
                  <a
                    href={viewing.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm font-semibold text-gray-700 hover:border-teal-300 hover:text-teal-600 transition-colors"
                  >
                    <ExternalLink size={15} />
                    Ouvrir dans un nouvel onglet
                  </a>
                )}
              </div>
            </div>

            {viewedMember && (
              <div>
                <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-2">
                  Membre concerné
                </h4>

                <div className="bg-gray-50 rounded-xl p-3">
                  <MemberAvatar
                    member={viewedMember}
                    size="md"
                    showName
                    showAge
                  />
                </div>
              </div>
            )}

            <div>
              <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">
                Informations
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs text-gray-400 font-medium flex items-center gap-1">
                    <Clock size={11} /> Téléversé le
                  </p>

                  <p className="text-sm font-semibold text-gray-700">
                    {formatDateTime(viewing.uploadedAt)}
                  </p>
                </div>

                {viewing.originalName && (
                  <div className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs text-gray-400 font-medium flex items-center gap-1">
                      <FileText size={11} /> Fichier d'origine
                    </p>

                    <p
                      className="text-sm font-semibold text-gray-700 truncate"
                      title={viewing.originalName}
                    >
                      {viewing.originalName}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {viewing.description && (
              <div>
                <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-2">
                  Description / Résumé
                </h4>

                <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm text-gray-700 whitespace-pre-wrap">
                  {viewing.description}
                </div>
              </div>
            )}

            {viewing.fileUrl && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide">
                    Aperçu du document
                  </h4>

                  <button
                    onClick={() =>
                      setShowPreview(!showPreview)
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-gray-200 rounded-lg text-gray-600 hover:border-teal-300 hover:text-teal-600 transition-colors"
                  >
                    {showPreview ? (
                      <EyeOff size={13} />
                    ) : (
                      <Eye size={13} />
                    )}

                    {showPreview
                      ? "Masquer l'aperçu"
                      : "Afficher l'aperçu"}
                  </button>
                </div>

                {showPreview && (
                  <div className="bg-gray-50 border border-gray-200 rounded-xl overflow-hidden">
                    {isViewingImage && (
                      <div className="flex items-center justify-center bg-white p-4">
                        <img
                          src={viewing.fileUrl}
                          alt={viewing.title}
                          className="max-w-full max-h-96 object-contain rounded-lg shadow-sm"
                          onLoad={() =>
                            setPreviewLoading(false)
                          }
                          onError={() =>
                            setPreviewLoading(false)
                          }
                        />
                      </div>
                    )}

                    {isViewingPdf && (
                      <div className="relative">
                        {previewLoading && (
                          <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
                            <Loader2
                              className="animate-spin text-teal-600"
                              size={28}
                            />
                          </div>
                        )}

                        <iframe
                          src={`${viewing.fileUrl}#view=FitH`}
                          title={viewing.title}
                          className="w-full h-96 bg-white"
                          onLoad={() =>
                            setPreviewLoading(false)
                          }
                        />
                      </div>
                    )}

                    {!isViewingImage &&
                      !isViewingPdf && (
                        <div className="flex flex-col items-center justify-center p-10 text-center">
                          <div className="w-16 h-16 bg-violet-100 rounded-2xl flex items-center justify-center mb-3">
                            <FileText
                              size={28}
                              className="text-violet-600"
                            />
                          </div>

                          <p className="text-sm font-semibold text-gray-700 mb-1">
                            {viewing.originalName ??
                              viewing.title}
                          </p>

                          <p className="text-xs text-gray-500 mb-4">
                            Aperçu non disponible pour ce type de fichier.
                          </p>

                          <a
                            href={viewing.fileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-xl text-sm font-semibold hover:bg-teal-700 transition-colors"
                          >
                            <ExternalLink size={15} />
                            Télécharger / Ouvrir le fichier
                          </a>
                        </div>
                      )}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-3 pt-2 border-t border-gray-100">
              {canWriteMember(viewing.memberId) && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    deleteDoc(viewing.id)
                  }
                  className="flex-1 text-red-500 hover:bg-red-50"
                >
                  <Trash2 size={15} />
                  Supprimer
                </Button>
              )}

              {canWriteMember(viewing.memberId) && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    openEditDoc(viewing)
                  }
                  className="flex-1"
                >
                  <Pencil size={15} />
                  Modifier
                </Button>
              )}

              <Button
                onClick={() => setViewing(null)}
                className="flex-1"
              >
                Fermer
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={
          editing
            ? "Modifier le document"
            : "Ajouter un document médical"
        }
        size="lg"
      >
        <div className="space-y-4">
          <Select
            label="Membre *"
            value={form.memberId}
            onChange={f("memberId")}
          >
            <option value="">
              Sélectionnez un membre
            </option>

            {/* Uniquement les fiches sur lesquelles l'utilisateur peut écrire */}
            {writableMembers.map((m) => (
              <option
                key={m.id}
                value={m.id}
              >
                {m.firstName} {m.lastName}
              </option>
            ))}
          </Select>

          <Input
            label="Titre du document *"
            placeholder="Résultat prise de sang, Ordonnance Dr. Martin..."
            value={form.title}
            onChange={f("title")}
          />

          <Select
            label="Type de document *"
            value={form.documentType}
            onChange={f("documentType")}
          >
            {DOCUMENT_TYPES.map((dt) => (
              <option
                key={dt.value}
                value={dt.value}
              >
                {dt.label}
              </option>
            ))}
          </Select>

          <Textarea
            label="Description / Résumé"
            placeholder="Informations importantes du document..."
            value={form.description}
            onChange={f("description")}
          />

          <div>
            <label className="text-sm font-semibold text-gray-700 block mb-1.5">
              Fichier
            </label>

            {!file ? (
              <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-gray-200 rounded-xl px-4 py-6 cursor-pointer hover:border-teal-400 hover:bg-teal-50/40 transition-colors">
                <UploadCloud
                  size={24}
                  className="text-gray-400"
                />

                <span className="text-sm text-gray-500">
                  Cliquez pour choisir un fichier (PDF, image, Word)
                </span>

                <span className="text-xs text-gray-400">
                  Taille max : 15 Mo
                </span>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_TYPES}
                  onChange={handleFileChange}
                  className="hidden"
                />
              </label>
            ) : (
              <div className="flex items-center justify-between gap-3 border border-gray-200 rounded-xl px-4 py-3 bg-gray-50">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText
                    size={18}
                    className="text-teal-600 flex-shrink-0"
                  />

                  <span className="text-sm text-gray-700 truncate">
                    {file.name}
                  </span>

                  <span className="text-xs text-gray-400 flex-shrink-0">
                    ({(file.size / 1024 / 1024).toFixed(1)} Mo)
                  </span>
                </div>

                <button
                  type="button"
                  onClick={removeFile}
                  className="p-1 rounded-lg hover:bg-gray-200 text-gray-500 flex-shrink-0"
                >
                  <X size={16} />
                </button>
              </div>
            )}

            <p className="text-xs text-gray-400 mt-1.5">
              Le fichier est optionnel : vous pouvez aussi créer une fiche
              sans document joint.
            </p>
          </div>

          <div className="flex gap-3 pt-2">
            <Button
              variant="ghost"
              onClick={() =>
                setShowForm(false)
              }
              className="flex-1"
            >
              Annuler
            </Button>

            <Button
              onClick={save}
              loading={saving}
              className="flex-1"
            >
              {editing
                ? "Enregistrer"
                : "Ajouter"}
            </Button>
          </div>
        </div>
      </Modal>
    </AppShell>
  );
}