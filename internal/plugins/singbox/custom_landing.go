package singbox

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

type customLanding struct {
	Scheme            string
	Server            string
	Port              int
	Username          string
	Password          string
	SNI               string
	Insecure          bool
	CongestionControl string
	UDPRelayMode      string
}

func parseCustomLandingURL(raw string) (customLanding, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil {
		return customLanding{}, fmt.Errorf("invalid custom landing URL: %w", err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "anytls" && scheme != "http" && scheme != "https" && scheme != "socks5" && scheme != "socks" && scheme != "tuic" {
		return customLanding{}, fmt.Errorf("unsupported custom landing scheme %q", u.Scheme)
	}
	if u.Hostname() == "" {
		return customLanding{}, fmt.Errorf("custom landing URL must include host")
	}
	portText := u.Port()
	if portText == "" {
		return customLanding{}, fmt.Errorf("custom landing URL must include a valid port")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return customLanding{}, fmt.Errorf("custom landing URL must include a valid port")
	}
	if u.Path != "" && u.Path != "/" {
		return customLanding{}, fmt.Errorf("custom landing URL must not include a path")
	}
	c := customLanding{Scheme: scheme, Server: u.Hostname(), Port: port}
	q := u.Query()
	if u.User != nil {
		c.Username = u.User.Username()
		if pw, ok := u.User.Password(); ok {
			c.Password = pw
		} else if scheme == "anytls" {
			c.Password = c.Username
		}
	}
	if q.Get("password") != "" && c.Password == "" {
		c.Password = q.Get("password")
	}
	c.SNI = q.Get("sni")
	if c.SNI == "" {
		c.SNI = c.Server
	}
	if value := q.Get("insecure"); value != "" {
		c.Insecure, err = strconv.ParseBool(value)
		if err != nil {
			return customLanding{}, fmt.Errorf("custom landing insecure must be true, false, 1, or 0")
		}
	} else if scheme == "tuic" {
		c.Insecure = true
	}
	if scheme == "anytls" && c.Password == "" {
		return customLanding{}, fmt.Errorf("anytls custom landing requires a password")
	}
	if scheme == "tuic" {
		if c.Username == "" || c.Password == "" {
			return customLanding{}, fmt.Errorf("tuic custom landing requires uuid and password")
		}
		c.CongestionControl = q.Get("congestion_control")
		if c.CongestionControl != "" && c.CongestionControl != "cubic" && c.CongestionControl != "new_reno" && c.CongestionControl != "bbr" {
			return customLanding{}, fmt.Errorf("tuic congestion_control must be cubic, new_reno, or bbr")
		}
		c.UDPRelayMode = q.Get("udp_relay_mode")
		if c.UDPRelayMode != "" && c.UDPRelayMode != "native" && c.UDPRelayMode != "quic" {
			return customLanding{}, fmt.Errorf("tuic udp_relay_mode must be native or quic")
		}
	}
	return c, nil
}

func renderCustomRelayOutbound(in InboundView) (map[string]any, error) {
	c, err := parseCustomLandingURL(in.CustomUpstreamURL)
	if err != nil {
		return nil, err
	}
	tag := "to-custom-" + in.Tag
	ob := map[string]any{"tag": tag, "server": c.Server, "server_port": c.Port}
	switch c.Scheme {
	case "anytls":
		ob["type"] = "anytls"
		ob["password"] = c.Password
		ob["tls"] = map[string]any{"enabled": true, "server_name": c.SNI, "insecure": c.Insecure}
	case "http", "https":
		ob["type"] = "http"
		if c.Username != "" {
			ob["username"] = c.Username
		}
		if c.Password != "" {
			ob["password"] = c.Password
		}
		if c.Scheme == "https" {
			ob["tls"] = map[string]any{"enabled": true, "server_name": c.SNI, "insecure": c.Insecure}
		}
	case "socks", "socks5":
		ob["type"] = "socks"
		ob["version"] = "5"
		if c.Username != "" {
			ob["username"] = c.Username
		}
		if c.Password != "" {
			ob["password"] = c.Password
		}
	case "tuic":
		ob["type"] = "tuic"
		ob["uuid"] = c.Username
		ob["password"] = c.Password
		cc := c.CongestionControl
		if cc == "" {
			cc = "cubic"
		}
		mode := c.UDPRelayMode
		if mode == "" {
			mode = "native"
		}
		ob["congestion_control"] = cc
		ob["udp_relay_mode"] = mode
		ob["zero_rtt_handshake"] = false
		ob["tls"] = map[string]any{
			"enabled":     true,
			"server_name": c.SNI,
			"insecure":    c.Insecure,
			"alpn":        []any{"h3"},
		}
	}
	return ob, nil
}
