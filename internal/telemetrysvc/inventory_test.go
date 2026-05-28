package telemetrysvc

import (
	"context"
	"strings"
	"testing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

func TestHostInventory_UpsertAndQuery(t *testing.T) {
	ing, serverID := newIngest(t)
	q := &Query{DB: ing.DB}
	ctx := context.Background()

	inv := agentapi.HostInventory{
		CPUPhysical: 4, CPULogical: 8, CPUModel: "Xeon E5",
		MemTotal: 16 << 30, DiskTotal: 512 << 30,
		GPUs: []agentapi.GPU{{Name: "RTX 4090", VRAMMiB: 24564}},
	}
	if err := ing.WriteHostInventory(ctx, serverID, inv); err != nil {
		t.Fatal(err)
	}
	row, err := q.HostInventory(ctx, serverID)
	if err != nil || row == nil {
		t.Fatalf("query: row=%v err=%v", row, err)
	}
	if row.CPUPhysical != 4 || row.CPULogical != 8 || row.MemTotal != 16<<30 || row.DiskTotal != 512<<30 {
		t.Fatalf("row mismatch: %+v", row)
	}
	if !strings.Contains(row.GPUsJSON, "RTX 4090") {
		t.Fatalf("gpus_json: %q", row.GPUsJSON)
	}
	inv.CPULogical = 16
	if err := ing.WriteHostInventory(ctx, serverID, inv); err != nil {
		t.Fatal(err)
	}
	row, _ = q.HostInventory(ctx, serverID)
	if row.CPULogical != 16 {
		t.Fatalf("upsert did not update: %+v", row)
	}
	if r, err := q.HostInventory(ctx, 999); err != nil || r != nil {
		t.Fatalf("missing: r=%v err=%v", r, err)
	}
}
