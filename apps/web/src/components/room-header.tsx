import { Gavel, Radio, Settings2 } from "lucide-react";

interface RoomHeaderProps {
  connectionLabel: string;
  connected: boolean;
  apiDocsUrl: string;
  onOpenSetup: () => void;
}

export function RoomHeader({
  connectionLabel,
  connected,
  apiDocsUrl,
  onOpenSetup,
}: RoomHeaderProps) {
  return (
    <header className="room-header">
      <a className="brand" href="/" aria-label="Gavel Live home">
        <Gavel size={25} strokeWidth={2.5} />
        <span>Gavel Live</span>
      </a>
      <nav aria-label="Room navigation">
        <a href="#room">Room</a>
        <a href="#events">Events</a>
        <a href={apiDocsUrl} target="_blank" rel="noreferrer">
          API
        </a>
      </nav>
      <div className="header-actions">
        <div className={`connection ${connected ? "is-connected" : ""}`}>
          <Radio size={15} />
          <span>{connectionLabel}</span>
        </div>
        <button className="header-button" onClick={onOpenSetup} type="button">
          <Settings2 size={14} />
          Room setup
        </button>
      </div>
    </header>
  );
}
