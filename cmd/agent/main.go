package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hg-claw/Shepherd/internal/agent/collector"
	"github.com/hg-claw/Shepherd/internal/agent/fingerprint"
	"github.com/hg-claw/Shepherd/internal/agent/hostinfo"
	"github.com/hg-claw/Shepherd/internal/agent/netqualitysampler"
	"github.com/hg-claw/Shepherd/internal/agent/singboxv2sampler"
	"github.com/hg-claw/Shepherd/internal/agent/state"
	"github.com/hg-claw/Shepherd/internal/agent/wsclient"
	"github.com/hg-claw/Shepherd/internal/agent/xraysampler"
	"github.com/hg-claw/Shepherd/internal/agentconfig"
)

func main() {
	cfg, err := agentconfig.FromEnv()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	statePath := state.DefaultPath
	if cfg.StatePath != "" {
		statePath = cfg.StatePath
	}
	st := &state.Store{Path: statePath}

	loaded, err := st.Load()
	if err != nil {
		log.Fatalf("state load: %v", err)
	}
	if loaded.Fingerprint == "" {
		fp, err := fingerprint.Compute()
		if err != nil {
			log.Fatalf("fingerprint: %v", err)
		}
		loaded.Fingerprint = fp
		_ = st.Save(loaded)
	}

	hostname, _ := os.Hostname()

	col := &collector.Collector{}
	if loaded.TelemetryIntervalSeconds > 0 {
		col.SetInterval(loaded.TelemetryIntervalSeconds)
	} else {
		col.SetInterval(30)
	}

	client := wsclient.New(cfg, st, func(s int) { col.SetInterval(s) }, hostname)
	col.Sender = client

	trafficSampler := &xraysampler.Sampler{
		APIAddress: "127.0.0.1:28085",
		Interval:   30 * time.Second,
		Send:       client.Send,
	}
	client.TrafficSampler = trafficSampler

	singboxSampler := &singboxv2sampler.Sampler{
		Address:  "127.0.0.1:29091",
		Interval: 30 * time.Second,
		Send:     client.Send,
	}
	client.SingboxTrafficSampler = singboxSampler

	// netquality sampler runs idle until the server pushes a target
	// list (TypeNetqualityConfig). Interval comes from the same push.
	netqSampler := &netqualitysampler.Sampler{Send: client.Send}
	client.NetqualitySampler = netqSampler

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	client.HostInventory = hostinfo.Collect(ctx)

	go col.Run(ctx)
	if err := client.Run(ctx); err != nil {
		if errors.Is(err, wsclient.ErrPermanent) {
			log.Printf("permanent agent failure: %v", err)
			os.Exit(1)
		}
		log.Printf("agent stopped: %v", err)
	}
}
