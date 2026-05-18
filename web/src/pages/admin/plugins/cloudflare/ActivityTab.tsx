export default function ActivityTab() {
  return (
    <div className="text-[13px] text-muted-foreground">
      Cloudflare audit log integration is tracked separately — this tab will
      surface the most recent events once the <code>GET /audit</code> endpoint
      is wired up.
    </div>
  )
}
