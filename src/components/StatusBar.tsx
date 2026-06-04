import { useEffect, useState } from "react"

interface Props {
  session: { id: string; name: string; state: string } | null
  sessionCount: number
}

export default function StatusBar({ session, sessionCount }: Props) {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString("en-US", { hour12: false }))

  useEffect(() => {
    const interval = setInterval(() => {
      setTime(new Date().toLocaleTimeString("en-US", { hour12: false }))
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="status-bar">
      <span className="status-left">
        {session ? (
          <>
            <span className={`status-dot ${session.state}`}>●</span>
            {" "}{session.name}
          </>
        ) : (
          "No active session"
        )}
        {" | "}{sessionCount} session{sessionCount !== 1 ? "s" : ""}
      </span>
      <span className="status-right">
        Ctrl+N new | Ctrl+K kill | Ctrl+H handoff
        {" | "}<span className="status-clock">{time}</span>
      </span>
    </div>
  )
}
