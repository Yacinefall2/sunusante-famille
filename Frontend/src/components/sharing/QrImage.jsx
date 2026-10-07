import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { qrDataUrl } from "../../lib/partage";
import { cn } from "../../lib/utils";

// QR code d'un lien, généré localement (aucun service externe).
export function QrImage({ value, size = 200, className, alt = "QR code" }) {
  const [src, setSrc] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    if (!value) return undefined;
    qrDataUrl(value, size * 2)
      .then((url) => !cancelled && setSrc(url))
      .catch(() => !cancelled && setSrc(null));
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!src) {
    return (
      <div className={cn("flex items-center justify-center bg-gray-50 rounded-xl", className)} style={{ width: size, height: size }}>
        <Loader2 className="animate-spin text-teal-600" size={24} />
      </div>
    );
  }
  return <img src={src} alt={alt} width={size} height={size} className={cn("bg-white", className)} />;
}
