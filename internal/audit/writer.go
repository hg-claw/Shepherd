package audit

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/jmoiron/sqlx"
)

type Writer struct {
	DB  *sqlx.DB
	Now func() time.Time
}

func (w *Writer) Write(ctx context.Context, adminID, serverID *int64, action string, details map[string]any, errResult error) {
	now := w.Now().UTC()
	result := "ok"
	if errResult != nil {
		result = "error"
		if details == nil {
			details = map[string]any{}
		}
		details["error"] = errResult.Error()
	}
	b, _ := json.Marshal(details)
	if len(b) > 16*1024 {
		b, _ = json.Marshal(map[string]any{"truncated": true, "size": len(b)})
	}
	_, err := w.DB.ExecContext(ctx,
		`INSERT INTO audit_log(ts, admin_id, server_id, action, details_json, result)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		now, adminID, serverID, action, string(b), result)
	if err != nil {
		log.Printf("audit write: %v", err)
	}
}
