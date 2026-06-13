package transport

import (
	"bytes"
	"testing"

	"quantumchat/internal/crypto"
)

func sampleEnvelope(t *testing.T, ctLen int) *crypto.Envelope {
	a, _ := crypto.GenerateIdentity()
	b, _ := crypto.GenerateIdentity()
	msgID, _ := crypto.RandBytes(16)
	pt := bytes.Repeat([]byte("x"), ctLen)
	env, err := crypto.Seal(a, "AAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBB", b.DHPub.Bytes(), msgID, pt)
	if err != nil {
		t.Fatal(err)
	}
	return env
}

func TestEnvelopeSerializeRoundTrip(t *testing.T) {
	env := sampleEnvelope(t, 100)
	b, err := SerializeEnvelope(env)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseEnvelope(b)
	if err != nil {
		t.Fatal(err)
	}
	if got.SenderID != env.SenderID || got.RecipientID != env.RecipientID ||
		!bytes.Equal(got.Ciphertext, env.Ciphertext) || !bytes.Equal(got.Sig, env.Sig) ||
		!bytes.Equal(got.MsgID, env.MsgID) || !bytes.Equal(got.EphemeralPub, env.EphemeralPub) ||
		!bytes.Equal(got.Nonce, env.Nonce) {
		t.Fatal("envelope round-trip mismatch")
	}
}

func TestUpstreamChunkRoundTrip(t *testing.T) {
	zone := "qc.example.com"
	for _, size := range []int{1, 35, 200, 1024, 2048} {
		env := sampleEnvelope(t, size)
		data, _ := SerializeEnvelope(env)
		names, err := ChunkUpstream("deadbeef", zone, data, "s")
		if err != nil {
			t.Fatalf("chunk(%d): %v", size, err)
		}
		// Every name must be a legal DNS name and parse back.
		r := NewReassembler(1 << 20)
		var assembled []byte
		var done bool
		for _, name := range names {
			if len(name) > 255 {
				t.Fatalf("name too long: %d", len(name))
			}
			for _, label := range splitLabels(name) {
				if len(label) > 63 {
					t.Fatalf("label too long: %d", len(label))
				}
			}
			f, act, err := ParseUpstreamName(name, zone)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if act != "s" {
				t.Fatalf("action=%s", act)
			}
			c, out, err := r.Add(f)
			if err != nil {
				t.Fatalf("reassemble: %v", err)
			}
			if c {
				done, assembled = true, out
			}
		}
		if !done {
			t.Fatal("never completed")
		}
		if !bytes.Equal(assembled, data) {
			t.Fatalf("size %d: reassembled mismatch (%d vs %d)", size, len(assembled), len(data))
		}
	}
}

func TestDownstreamRoundTrip(t *testing.T) {
	for _, size := range []int{0, 1, 199, 200, 201, 5000} {
		data := bytes.Repeat([]byte{0xAB}, size)
		strs := EncodeDownstream(data, 200)
		for _, s := range strs {
			if len(s) > 200 {
				t.Fatalf("downstream string too long: %d", len(s))
			}
		}
		got, err := DecodeDownstream(strs)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, data) {
			t.Fatalf("size %d downstream mismatch", size)
		}
	}
}

func splitLabels(name string) []string {
	var out []string
	cur := ""
	for _, c := range name {
		if c == '.' {
			out = append(out, cur)
			cur = ""
		} else {
			cur += string(c)
		}
	}
	out = append(out, cur)
	return out
}
