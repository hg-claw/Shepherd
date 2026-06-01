package telemetrysvc

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentsvc"
	"github.com/hg-claw/Shepherd/internal/livenet"
	"github.com/jmoiron/sqlx"
)

type Ingest struct {
	DB      *sqlx.DB
	LiveNet *livenet.Hub // optional; live throughput fan-out
}

// HandleFrame is the FrameHandler injected into AgentAPI. It dispatches by envelope type.
func (i *Ingest) HandleFrame(ctx context.Context, serverID int64, env agentapi.Envelope) {
	switch env.Type {
	case agentapi.TypeTelemetry:
		var t agentapi.Telemetry
		if err := env.Decode(&t); err != nil {
			log.Printf("telemetry decode (server=%d): %v", serverID, err)
			return
		}
		if err := i.WriteSample(ctx, serverID, t); err != nil {
			log.Printf("telemetry write (server=%d): %v", serverID, err)
		}
	case agentapi.TypeHeartbeat:
		var h agentapi.Heartbeat
		if err := env.Decode(&h); err != nil {
			return
		}
		_, _ = i.DB.ExecContext(ctx, `UPDATE servers SET
			agent_last_seen=$1, agent_version=$2, agent_os=$3, agent_arch=$4, agent_kernel=$5
			WHERE id=$6`,
			time.Now().UTC(), h.AgentVersion, h.OS, h.Arch, h.Kernel, serverID)
		if len(h.IPCandidates) > 0 {
			cands := make([]agentsvc.IPCandidate, len(h.IPCandidates))
			for j, c := range h.IPCandidates {
				cands[j] = agentsvc.IPCandidate{Addr: c.Addr, Kind: c.Kind, Source: c.Source}
			}
			_ = agentsvc.SaveCandidates(ctx, i.DB, serverID, cands)
			_ = agentsvc.ApplyBestSSHHost(ctx, i.DB, serverID, cands)
		}
	case agentapi.TypeXrayTraffic:
		var batch agentapi.XrayTrafficBatch
		if err := env.Decode(&batch); err != nil {
			log.Printf("xray.traffic decode (server=%d): %v", serverID, err)
			return
		}
		if err := i.WriteTrafficBatch(ctx, serverID, batch.Samples); err != nil {
			log.Printf("xray.traffic write (server=%d): %v", serverID, err)
		}
	case agentapi.TypeSingboxTraffic:
		var batch agentapi.SingboxTrafficBatch
		if err := env.Decode(&batch); err != nil {
			log.Printf("singbox.traffic decode (server=%d): %v", serverID, err)
			return
		}
		if err := i.WriteSingboxTrafficBatch(ctx, serverID, batch.Samples); err != nil {
			log.Printf("singbox.traffic write (server=%d): %v", serverID, err)
		}
	case agentapi.TypeNetqualityBatch:
		var batch agentapi.NetqualityBatch
		if err := env.Decode(&batch); err != nil {
			log.Printf("netquality.batch decode (server=%d): %v", serverID, err)
			return
		}
		if err := i.WriteNetqualityBatch(ctx, serverID, batch.Samples); err != nil {
			log.Printf("netquality.batch write (server=%d): %v", serverID, err)
		}
	case agentapi.TypeHostInventory:
		var inv agentapi.HostInventory
		if err := env.Decode(&inv); err != nil {
			log.Printf("host.inventory decode (server=%d): %v", serverID, err)
			return
		}
		if err := i.WriteHostInventory(ctx, serverID, inv); err != nil {
			log.Printf("host.inventory write (server=%d): %v", serverID, err)
		}
	case agentapi.TypeLiveNet:
		if i.LiveNet == nil {
			return
		}
		var s agentapi.LiveNetSample
		if err := env.Decode(&s); err != nil {
			log.Printf("live.net decode (server=%d): %v", serverID, err)
			return
		}
		i.LiveNet.Publish(serverID, s)
	}
}

// WriteHostInventory upserts the static hardware inventory for a server.
func (i *Ingest) WriteHostInventory(ctx context.Context, serverID int64, inv agentapi.HostInventory) error {
	gpusJSON, _ := json.Marshal(inv.GPUs)
	_, err := i.DB.ExecContext(ctx, `INSERT INTO host_inventory
		(server_id, cpu_physical, cpu_logical, cpu_model, mem_total, disk_total, gpus_json, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (server_id) DO UPDATE SET
		  cpu_physical=EXCLUDED.cpu_physical, cpu_logical=EXCLUDED.cpu_logical,
		  cpu_model=EXCLUDED.cpu_model, mem_total=EXCLUDED.mem_total,
		  disk_total=EXCLUDED.disk_total, gpus_json=EXCLUDED.gpus_json,
		  updated_at=EXCLUDED.updated_at`,
		serverID, inv.CPUPhysical, inv.CPULogical, inv.CPUModel, inv.MemTotal, inv.DiskTotal,
		string(gpusJSON), time.Now().UTC())
	return err
}

// WriteSample persists one telemetry point, bumps host_traffic, and bumps
// agent_last_seen — atomically, in one transaction (one fsync instead of three).
func (i *Ingest) WriteSample(ctx context.Context, serverID int64, t agentapi.Telemetry) error {
	disksJSON, _ := json.Marshal(t.Disks)
	tx, err := i.DB.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }() // no-op after a successful Commit

	if _, err := tx.ExecContext(ctx, `INSERT INTO telemetry_samples_30s
		(server_id, ts, cpu_pct, mem_used, mem_total, load_1, load_5, load_15,
		 net_rx_bps, net_tx_bps, tcp_conn, disks_json)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		serverID, t.TS.UTC(), t.CPUPct, t.MemUsed, t.MemTotal, t.Load1, t.Load5, t.Load15,
		t.NetRxBps, t.NetTxBps, t.TCPConn, string(disksJSON)); err != nil {
		return err
	}
	if t.NetRxBytes != 0 || t.NetTxBytes != 0 {
		now := t.TS.UTC()
		if _, err := tx.ExecContext(ctx, `INSERT INTO host_traffic
			(server_id, cum_bytes_up, cum_bytes_down, last_reset_at, updated_at)
			VALUES ($1,$2,$3,$4,$4)
			ON CONFLICT (server_id) DO UPDATE SET
			  cum_bytes_up   = host_traffic.cum_bytes_up   + EXCLUDED.cum_bytes_up,
			  cum_bytes_down = host_traffic.cum_bytes_down + EXCLUDED.cum_bytes_down,
			  updated_at     = EXCLUDED.updated_at`,
			serverID, t.NetTxBytes, t.NetRxBytes, now); err != nil {
			return err
		}
	}
	// Liveness is the server's receipt time, NOT the agent-supplied t.TS: a
	// behind/mis-NTP'd agent clock would otherwise write a stale last_seen,
	// making the public wall show "offline" while the agent is actively
	// connected and reporting. (The sample's own ts above keeps t.TS — that's
	// the agent's measurement time for the time-series.) Matches the heartbeat
	// handler, which already bumps agent_last_seen with time.Now().UTC().
	if _, err := tx.ExecContext(ctx, "UPDATE servers SET agent_last_seen=$1 WHERE id=$2",
		time.Now().UTC(), serverID); err != nil {
		return err
	}
	return tx.Commit()
}
