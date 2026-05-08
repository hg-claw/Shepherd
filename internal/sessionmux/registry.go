package sessionmux

import (
	"sync"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// PTYConsumer is implemented by ptysvc.Session.
type PTYConsumer interface {
	DeliverBinary(kind byte, payload []byte)
	DeliverControl(env agentapi.Envelope)
}

// FileTransfer is implemented by filesvc upload/download state.
type FileTransfer interface {
	DeliverBinary(payload []byte)
	DeliverControl(env agentapi.Envelope)
}

type Registry struct {
	mu      sync.Mutex
	pty     map[string]PTYConsumer
	file    map[string]FileTransfer
	request map[string]chan agentapi.Envelope
}

func New() *Registry {
	return &Registry{
		pty:     map[string]PTYConsumer{},
		file:    map[string]FileTransfer{},
		request: map[string]chan agentapi.Envelope{},
	}
}

func (r *Registry) RegisterPTY(sid string, p PTYConsumer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pty[sid] = p
}
func (r *Registry) RegisterFile(sid string, f FileTransfer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.file[sid] = f
}
func (r *Registry) RegisterRequest(sid string) <-chan agentapi.Envelope {
	ch := make(chan agentapi.Envelope, 1)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.request[sid] = ch
	return ch
}
func (r *Registry) Unregister(sid string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.pty, sid)
	delete(r.file, sid)
	if ch, ok := r.request[sid]; ok {
		close(ch)
		delete(r.request, sid)
	}
}

func (r *Registry) Deliver(env agentapi.Envelope) bool {
	r.mu.Lock()
	p := r.pty[env.Sid]
	f := r.file[env.Sid]
	rq := r.request[env.Sid]
	r.mu.Unlock()
	if rq != nil {
		select {
		case rq <- env:
		default:
		}
		return true
	}
	if p != nil {
		p.DeliverControl(env)
		return true
	}
	if f != nil {
		f.DeliverControl(env)
		return true
	}
	return false
}

func (r *Registry) DeliverBinary(sid string, kind byte, payload []byte) bool {
	r.mu.Lock()
	p := r.pty[sid]
	f := r.file[sid]
	r.mu.Unlock()
	if p != nil {
		p.DeliverBinary(kind, payload)
		return true
	}
	if f != nil {
		f.DeliverBinary(payload)
		return true
	}
	return false
}
