package subgen

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// ParseShareLinks parses newline-separated proxy share links into Nodes. Blank
// lines and lines beginning with '#' are skipped. Unparseable or unsupported
// lines are skipped and reported in warnings (one per bad line). Warnings never
// echo the offending line, which may contain credentials.
func ParseShareLinks(text string) ([]Node, []string) {
	var nodes []Node
	var warns []string
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		n, err := parseShareLink(line)
		if err != nil {
			warns = append(warns, err.Error())
			continue
		}
		nodes = append(nodes, n)
	}
	return nodes, warns
}

func parseShareLink(line string) (Node, error) {
	switch {
	case strings.HasPrefix(line, "ss://"):
		return parseSS(line)
	case strings.HasPrefix(line, "vmess://"):
		return parseVMess(line)
	case strings.HasPrefix(line, "vless://"):
		return parseURINode(line, "vless")
	case strings.HasPrefix(line, "trojan://"):
		return parseURINode(line, "trojan")
	case strings.HasPrefix(line, "hysteria2://"), strings.HasPrefix(line, "hy2://"):
		return parseURINode(line, "hysteria2")
	case strings.HasPrefix(line, "tuic://"):
		return parseURINode(line, "tuic")
	case strings.HasPrefix(line, "anytls://"):
		return parseURINode(line, "anytls")
	default:
		return Node{}, fmt.Errorf("unsupported or unparseable share link")
	}
}

// splitFragment removes a trailing #fragment, returning (rest, decodedName).
// PathUnescape preserves '+' (unlike query unescaping); on error the raw
// fragment is used.
func splitFragment(s string) (string, string) {
	i := strings.LastIndex(s, "#")
	if i < 0 {
		return s, ""
	}
	name := s[i+1:]
	if dec, err := url.PathUnescape(name); err == nil {
		name = dec
	}
	return s[:i], name
}

func nameOr(name, server string, port int) string {
	if name != "" {
		return name
	}
	return server + ":" + strconv.Itoa(port)
}

// b64decode tries the common base64 variants used by share links.
func b64decode(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	for _, enc := range []*base64.Encoding{
		base64.RawURLEncoding, base64.URLEncoding,
		base64.RawStdEncoding, base64.StdEncoding,
	} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, fmt.Errorf("invalid base64")
}

func parseSS(line string) (Node, error) {
	rest, name := splitFragment(strings.TrimPrefix(line, "ss://"))
	if i := strings.Index(rest, "?"); i >= 0 { // drop ?plugin=…
		rest = rest[:i]
	}
	var method, password, hostport string
	if at := strings.LastIndex(rest, "@"); at >= 0 {
		// SIP002: base64(method:password)@host:port
		mp := rest[:at]
		if dec, err := b64decode(mp); err == nil {
			mp = string(dec)
		}
		ci := strings.Index(mp, ":")
		if ci < 0 {
			return Node{}, fmt.Errorf("ss: bad method:password")
		}
		method, password = mp[:ci], mp[ci+1:]
		hostport = rest[at+1:]
	} else {
		// legacy: base64(method:password@host:port)
		dec, err := b64decode(rest)
		if err != nil {
			return Node{}, fmt.Errorf("ss: invalid base64")
		}
		full := string(dec)
		at2 := strings.LastIndex(full, "@")
		if at2 < 0 {
			return Node{}, fmt.Errorf("ss: bad legacy format")
		}
		mp := full[:at2]
		ci := strings.Index(mp, ":")
		if ci < 0 {
			return Node{}, fmt.Errorf("ss: bad method:password")
		}
		method, password = mp[:ci], mp[ci+1:]
		hostport = full[at2+1:]
	}
	host, port, err := splitHostPort(hostport)
	if err != nil {
		return Node{}, fmt.Errorf("ss: %v", err)
	}
	return Node{
		Protocol: "shadowsocks", Server: host, Port: port,
		SSMethod: method, Password: password, Name: nameOr(name, host, port),
	}, nil
}

func parseVMess(line string) (Node, error) {
	dec, err := b64decode(strings.TrimPrefix(line, "vmess://"))
	if err != nil {
		return Node{}, fmt.Errorf("vmess: invalid base64")
	}
	var j struct {
		PS   string `json:"ps"`
		Add  string `json:"add"`
		Port any    `json:"port"`
		ID   string `json:"id"`
		Net  string `json:"net"`
		Host string `json:"host"`
		Path string `json:"path"`
		TLS  string `json:"tls"`
		SNI  string `json:"sni"`
	}
	if err := json.Unmarshal(dec, &j); err != nil {
		return Node{}, fmt.Errorf("vmess: bad json")
	}
	port := toInt(j.Port)
	if j.Add == "" || port == 0 {
		return Node{}, fmt.Errorf("vmess: missing add/port")
	}
	n := Node{Protocol: "vmess", Server: j.Add, Port: port, UUID: j.ID, Name: j.PS}
	if j.Net == "ws" {
		n.Transport = "ws"
		n.Path = j.Path
		n.Host = j.Host
	}
	if j.TLS == "tls" {
		if n.SNI = j.SNI; n.SNI == "" {
			n.SNI = j.Host
		}
	}
	n.Name = nameOr(n.Name, n.Server, port)
	return n, nil
}

func toInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case string:
		n, _ := strconv.Atoi(t)
		return n
	}
	return 0
}

func parseURINode(line, proto string) (Node, error) {
	body, name := splitFragment(line)
	u, err := url.Parse(body)
	if err != nil {
		return Node{}, fmt.Errorf("%s: parse error", proto)
	}
	host := u.Hostname()
	port, err := strconv.Atoi(u.Port())
	if err != nil || host == "" {
		return Node{}, fmt.Errorf("%s: missing host/port", proto)
	}
	q := u.Query()
	n := Node{Protocol: proto, Server: host, Port: port, Name: nameOr(name, host, port)}
	switch proto {
	case "vless":
		n.UUID = u.User.Username()
		n.Flow = q.Get("flow")
		n.SNI = q.Get("sni")
		if q.Get("security") == "reality" {
			n.RealityPublicKey = q.Get("pbk")
			n.RealityShortID = q.Get("sid")
		}
		if q.Get("type") == "ws" {
			n.Transport = "ws"
			n.Path = q.Get("path")
			n.Host = q.Get("host")
		}
	case "trojan":
		n.Password = u.User.Username()
		if n.SNI = q.Get("sni"); n.SNI == "" {
			n.SNI = q.Get("peer")
		}
		if q.Get("type") == "ws" {
			n.Transport = "ws"
			n.Path = q.Get("path")
			n.Host = q.Get("host")
		}
		n.Insecure = q.Get("allowInsecure") == "1"
	case "hysteria2":
		n.Password = u.User.Username()
		n.SNI = q.Get("sni")
		n.Insecure = q.Get("insecure") == "1"
	case "tuic":
		n.UUID = u.User.Username()
		n.Password, _ = u.User.Password()
		n.SNI = q.Get("sni")
		if cc := q.Get("congestion_control"); cc != "" {
			n.Extra = map[string]any{"congestion_control": cc}
		}
	case "anytls":
		n.Password = u.User.Username()
		n.SNI = q.Get("sni")
		n.Insecure = q.Get("insecure") == "1"
	}
	return n, nil
}

// splitHostPort handles IPv4/host and bracketed IPv6, returning host + numeric port.
func splitHostPort(hp string) (string, int, error) {
	host, ps, err := net.SplitHostPort(hp)
	if err != nil {
		return "", 0, fmt.Errorf("bad host:port")
	}
	port, err := strconv.Atoi(ps)
	if err != nil {
		return "", 0, fmt.Errorf("bad port")
	}
	return host, port, nil
}
