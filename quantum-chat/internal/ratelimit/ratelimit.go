// Package ratelimit provides a per-key token-bucket limiter used to throttle
// abusive senders/pollers by source (client IP and/or sender txid prefix).
package ratelimit

import (
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	last   time.Time
}

// Limiter is a refilling token-bucket keyed by an arbitrary string.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64 // tokens per second
	burst   float64 // max tokens
	lastGC  time.Time
}

// New creates a limiter allowing `perMinute` events/min with burst == perMinute.
func New(perMinute int) *Limiter {
	if perMinute < 1 {
		perMinute = 1
	}
	return &Limiter{
		buckets: map[string]*bucket{},
		rate:    float64(perMinute) / 60.0,
		burst:   float64(perMinute),
		lastGC:  time.Now(),
	}
}

// Allow consumes one token for key. Returns false if the bucket is empty.
func (l *Limiter) Allow(key string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	// refill
	elapsed := now.Sub(b.last).Seconds()
	b.tokens += elapsed * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now

	if b.tokens < 1 {
		l.gc(now)
		return false
	}
	b.tokens--
	l.gc(now)
	return true
}

// gc drops idle buckets occasionally to bound memory. Caller holds the lock.
func (l *Limiter) gc(now time.Time) {
	if now.Sub(l.lastGC) < time.Minute {
		return
	}
	l.lastGC = now
	for k, b := range l.buckets {
		if now.Sub(b.last) > 10*time.Minute {
			delete(l.buckets, k)
		}
	}
}
