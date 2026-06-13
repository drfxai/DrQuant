package ratelimit

import "testing"

func TestBurstThenDeny(t *testing.T) {
	l := New(5) // 5/min, burst 5
	allowed := 0
	for i := 0; i < 5; i++ {
		if l.Allow("ip1") {
			allowed++
		}
	}
	if allowed != 5 {
		t.Fatalf("expected 5 allowed in burst, got %d", allowed)
	}
	if l.Allow("ip1") {
		t.Fatal("6th call should be denied")
	}
	// Different key has its own bucket.
	if !l.Allow("ip2") {
		t.Fatal("independent key should be allowed")
	}
}
