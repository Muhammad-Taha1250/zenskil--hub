-- Phase 8 (G-1 mechanism): per-product fulfillment instructions, editable by
-- the owner without code. The admin task queue snapshots this text into each
-- fulfillment task so staff always know what the customer must receive.
ALTER TABLE "products" ADD COLUMN "fulfillment_notes" TEXT;
