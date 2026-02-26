# Take-Home Exercise — Session Service Design

## Overview

Design and (optionally) implement a Session Service for a web platform deployed on on-prem infrastructure.

This exercise evaluates your ability to design identity and session lifecycle systems that support both anonymous and authenticated users while meeting scalability, security, and performance requirements.

You do not need to build a fully production-ready system. Focus on clear reasoning, tradeoffs, and design quality.

---

## Functional Requirements

Your session service must support:

### Session expiration

Sessions expire after 30 minutes of inactivity (sliding window).

### Session migration tracking

Track transitions such as:

- anonymous → authenticated
- device change
- session merge

Preserve lineage/history where appropriate.

### Session data collection

Capture session metadata including:

- referrer
- user agent
- timestamps
- IP address (if used)
- extensible/custom attributes

### Persistent login

Users remain logged in across revisits regardless of timeframe.
Design how persistent identity is maintained securely.

### Identity support

The platform supports:

- logged-out (anonymous) visitors
- logged-in customers
- transitions between the two

### Cross-service continuity

Sessions must be retrievable and usable across multiple services.

---

## Non-Functional Requirements

Your design should address:

- On-prem deployment constraints
- High read/write throughput
- Horizontal scalability
- Low latency session lookup (target: ~10 ms)
- Secure session handling
- Operational reliability

---

## Expected Deliverables

Please provide:

### 1. Architecture diagram

- Major components
- Data flow
- Request path

### 2. API design

Example endpoints (suggested):

- create session
- fetch session
- update activity
- attach identity (login)
- invalidate session
- migrate / merge session

### 3. Data model / storage design

- Session schema
- Identity relationships
- Indexing / partitioning approach
- TTL / lifecycle handling
- Attribute extensibility

### 4. Expiration strategy

- Sliding inactivity implementation
- Tradeoffs (TTL vs background jobs, etc.)

### 5. Migration strategy

- Anonymous → authenticated
- Multi-device behavior
- Session lineage / merge rules

### 6. Security model

- Token / cookie strategy
- Session fixation mitigation
- Replay protection
- Sensitive data handling
- Rotation / revocation approach

### 7. Scalability & performance considerations

- Storage scaling
- Read vs write path
- Hot vs cold data
- Caching strategy (if any)
- Expected bottlenecks
- Server considerations

### 8. Tradeoffs & alternatives

- Explain key design decisions
- What you would change at 10× scale
- Operational risks

### 9. (Optional) Prototype

Small implementation or pseudocode demonstrating core concepts

---

## Constraints & Assumptions

You may assume:

- Multiple stateless application services
- High traffic environment
- Both browser and mobile clients
- On-prem infrastructure (no managed cloud primitives unless replaced with equivalent concepts)

Clearly state any additional assumptions you make.

---

## Time Expectation

**Recommended time:** 3–5 hours.

We value clarity of thinking over completeness.

---

## Submission Instructions

Please be prepared to present your design and interactively discuss modifications or how it could handle new requirements.

Please use whatever tools you are comfortable with; it will just need to be shareable. GoogleDoc, PowerPoint, LucidChart, Mermaid, Word document, or equivalent artifact for us to review a day ahead of time would be preferred.

---

## Evaluation Focus

We will evaluate:

- Identity and session modeling
- Storage design and scalability reasoning
- Expiration and lifecycle strategy
- Migration handling
- Security awareness
- Performance considerations
- Clarity of communication and tradeoffs
