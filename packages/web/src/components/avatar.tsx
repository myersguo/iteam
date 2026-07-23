import React, { useEffect, useState } from "react";
import { Avatar as ArcoAvatar } from "@arco-design/web-react";

export function Avatar({
  name,
  agent,
  large,
  avatarUrl
}: {
  name: string;
  agent?: boolean;
  large?: boolean;
  avatarUrl?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [avatarUrl]);

  return (
    <ArcoAvatar className={`avatar ${agent ? "is-agent" : ""} ${large ? "is-large" : ""}`} autoFixFontSize>
      {avatarUrl && !imageFailed ? (
        <img src={avatarUrl} alt="" onError={() => setImageFailed(true)} />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </ArcoAvatar>
  );
}
