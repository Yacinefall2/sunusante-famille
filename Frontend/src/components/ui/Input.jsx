import { cn } from "../../lib/utils";
import { forwardRef, useId } from "react";

// Identifiant du champ : celui fourni par l'appelant, sinon un identifiant
// généré, pour relier le <label> à son champ (lecteurs d'écran, clic sur le
// libellé qui place le curseur dans le champ).
function useFieldId(id) {
  const generated = useId();
  return id ?? generated;
}

export const Input = forwardRef(({ className, label, error, id, ...props }, ref) => {
  const fieldId = useFieldId(id);
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={fieldId} className="text-sm font-semibold text-gray-700">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={fieldId}
        className={cn(
          "w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50",
          "text-gray-800 placeholder-gray-400",
          "focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 focus:bg-white",
          "transition-all duration-200",
          error && "border-red-400 focus:ring-red-400",
          className
        )}
        {...props}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
});
Input.displayName = "Input";

export const Textarea = forwardRef(({ className, label, error, id, ...props }, ref) => {
  const fieldId = useFieldId(id);
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={fieldId} className="text-sm font-semibold text-gray-700">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={fieldId}
        className={cn(
          "w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50",
          "text-gray-800 placeholder-gray-400 resize-none",
          "focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 focus:bg-white",
          "transition-all duration-200",
          error && "border-red-400 focus:ring-red-400",
          className
        )}
        rows={3}
        {...props}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
});
Textarea.displayName = "Textarea";

export const Select = forwardRef(({ className, label, error, id, children, ...props }, ref) => {
  const fieldId = useFieldId(id);
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={fieldId} className="text-sm font-semibold text-gray-700">
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={fieldId}
        className={cn(
          "w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50",
          "text-gray-800",
          "focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 focus:bg-white",
          "transition-all duration-200",
          error && "border-red-400 focus:ring-red-400",
          className
        )}
        {...props}
      >
        {children}
      </select>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
});
Select.displayName = "Select";
