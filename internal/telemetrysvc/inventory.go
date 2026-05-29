package telemetrysvc

import (
	"context"
	"database/sql"
	"errors"
)

// HostInventoryRow is the stored inventory for one server.
type HostInventoryRow struct {
	ServerID    int64  `db:"server_id"    json:"server_id"`
	CPUPhysical int    `db:"cpu_physical" json:"cpu_physical"`
	CPULogical  int    `db:"cpu_logical"  json:"cpu_logical"`
	CPUModel    string `db:"cpu_model"    json:"cpu_model"`
	MemTotal    int64  `db:"mem_total"    json:"mem_total"`
	DiskTotal   int64  `db:"disk_total"   json:"disk_total"`
	GPUsJSON    string `db:"gpus_json"    json:"-"`
}

// HostInventory returns the stored inventory for a server, or nil if none.
func (q *Query) HostInventory(ctx context.Context, serverID int64) (*HostInventoryRow, error) {
	var row HostInventoryRow
	err := q.DB.GetContext(ctx, &row,
		`SELECT server_id, cpu_physical, cpu_logical, cpu_model, mem_total, disk_total, gpus_json
		   FROM host_inventory WHERE server_id=$1`, serverID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}
