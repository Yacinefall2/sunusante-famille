import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

// `description` (facultatif) : phrase lue par les lecteurs d'écran à
// l'ouverture. Sans elle, la boîte de dialogue déclare explicitement ne pas
// avoir de description (évite l'avertissement de Radix).
export function Modal({ open, onClose, title, description, children, size = "md" }) {
  const sizeClass = {
    sm: "max-w-sm",
    md: "max-w-lg",
    lg: "max-w-2xl",
  }[size];

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 animate-in fade-in" />
        <Dialog.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50",
            "w-[calc(100%-2rem)] bg-white rounded-2xl shadow-2xl",
            "max-h-[90vh] overflow-y-auto",
            sizeClass
          )}
        >
          <div className="flex items-center justify-between gap-3 p-4 sm:p-6 border-b border-gray-100">
            <Dialog.Title className="text-lg sm:text-xl font-bold text-gray-800 min-w-0 break-words">{title}</Dialog.Title>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fermer"
              className="flex-shrink-0 p-2 rounded-xl hover:bg-gray-100 transition-colors text-gray-500 hover:text-gray-700"
            >
              <X size={20} />
            </button>
          </div>
          {description && <Dialog.Description className="sr-only">{description}</Dialog.Description>}
          <div className="p-4 sm:p-6">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
