import { calculateAge } from "../../lib/utils";

export function MemberAvatar({ member, size = "md", showName = false, showAge = false }) {
  const initials = `${member.firstName[0]}${member.lastName[0]}`.toUpperCase();
  const age = calculateAge(member.dateOfBirth);

  const sizeClass = {
    sm: "w-8 h-8 text-xs",
    md: "w-10 h-10 text-sm",
    lg: "w-14 h-14 text-lg",
    xl: "w-20 h-20 text-2xl",
  }[size];

  return (
    <div className="flex items-center gap-3">
      <div
        className={`${sizeClass} rounded-full flex items-center justify-center font-bold text-white flex-shrink-0 shadow-md`}
        style={{ backgroundColor: member.avatarColor ?? "#3B82F6" }}
      >
        {initials}
      </div>
      {showName && (
        <div>
          <p className="font-semibold text-gray-800">
            {member.firstName} {member.lastName}
          </p>
          {showAge && age !== null && <p className="text-xs text-gray-500">{age} ans</p>}
        </div>
      )}
    </div>
  );
}
