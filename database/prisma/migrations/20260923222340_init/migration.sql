-- pgvector extension (required for knowledge_base_chunks.embedding)
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "CustomerState" AS ENUM ('NEW', 'BROWSING', 'SELECTING_PRODUCT', 'SELECTING_PLAN', 'WAITING_FOR_CUSTOMER_DETAILS', 'ORDER_CREATED', 'AWAITING_PAYMENT', 'PAYMENT_PROCESSING', 'PAYMENT_CONFIRMED', 'FULFILLMENT_PENDING', 'FULFILLMENT_PROCESSING', 'FULFILLED', 'ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'SUPPORT_REQUIRED', 'CANCELLED', 'REFUND_REQUESTED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'AWAITING_PAYMENT', 'PAYMENT_PROCESSING', 'PAYMENT_CONFIRMED', 'FULFILLING', 'FULFILLED', 'ACTIVE', 'CANCELLED', 'REFUND_REQUESTED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'EXPIRED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'MANUAL_REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "FulfillmentStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'ASSIGNED', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketAuthorType" AS ENUM ('CUSTOMER', 'AGENT', 'AI', 'SYSTEM');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApprovalActionType" AS ENUM ('REFUND', 'MANUAL_PAYMENT', 'PRICE_CHANGE', 'POLICY_CHANGE', 'CREDENTIAL_CHANGE', 'CUSTOMER_DELETE');

-- CreateEnum
CREATE TYPE "KbStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('en', 'roman-ur', 'ur');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CouponType" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('UTILITY', 'MARKETING', 'AUTHENTICATION');

-- CreateEnum
CREATE TYPE "TemplateMetaStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('ADMIN', 'CUSTOMER', 'SYSTEM', 'AI');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "whatsapp_number" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "language" "Language" NOT NULL DEFAULT 'en',
    "opted_in" BOOLEAN NOT NULL DEFAULT true,
    "state" "CustomerState" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID,
    "email" TEXT,
    "password_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "totp_secret" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "short_description" TEXT,
    "long_description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "duration_months" INTEGER NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "price_paisa" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "subtotal_paisa" INTEGER NOT NULL,
    "discount_paisa" INTEGER NOT NULL DEFAULT 0,
    "total_paisa" INTEGER NOT NULL,
    "coupon_id" UUID,
    "attribution" JSONB NOT NULL DEFAULT '{}',
    "source_channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "payment_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_paisa" INTEGER NOT NULL,
    "total_paisa" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "amount_paisa" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "proof_url" TEXT,
    "proof_hash" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_payload" JSONB NOT NULL,
    "response_payload" JSONB,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_id" UUID NOT NULL,
    "amount_paisa" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by" UUID NOT NULL,
    "approved_by" UUID,
    "provider_refund_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "type" "CouponType" NOT NULL,
    "value" INTEGER NOT NULL,
    "max_uses" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "valid_from" TIMESTAMPTZ(6),
    "valid_to" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "renewal_reminder_stage" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "state" "CustomerState" NOT NULL DEFAULT 'NEW',
    "context" JSONB NOT NULL DEFAULT '{}',
    "return_state" "CustomerState",
    "last_inbound_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "whatsapp_message_id" TEXT,
    "message_type" TEXT NOT NULL DEFAULT 'text',
    "body_text" TEXT,
    "template_name" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "subject" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "assigned_to" UUID,
    "return_state" "CustomerState",
    "resolved_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "author_type" "TicketAuthorType" NOT NULL,
    "author_id" UUID,
    "body_text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "KbStatus" NOT NULL DEFAULT 'DRAFT',
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "knowledge_base_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_base_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "template_name" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "whatsapp_message_id" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "category" "TemplateCategory" NOT NULL DEFAULT 'UTILITY',
    "body" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "meta_status" "TemplateMetaStatus" NOT NULL DEFAULT 'DRAFT',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "processing_status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "processed_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attributions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID,
    "order_id" UUID,
    "source" TEXT NOT NULL,
    "campaign" TEXT,
    "adset" TEXT,
    "ad" TEXT,
    "utm" JSONB NOT NULL DEFAULT '{}',
    "referral" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "task_type" TEXT NOT NULL DEFAULT 'deliver_service',
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "status" "FulfillmentStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "assigned_to" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fulfillment_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "action_type" "ApprovalActionType" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pending_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "business_hours" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "day_of_week" INTEGER NOT NULL,
    "open_time" TEXT,
    "close_time" TEXT,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Karachi',

    CONSTRAINT "business_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "ip_address" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_sequences" (
    "day" CHAR(8) NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_sequences_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_whatsapp_number_key" ON "customers"("whatsapp_number");

-- CreateIndex
CREATE UNIQUE INDEX "users_customer_id_key" ON "users"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "plans_product_id_name_key" ON "plans"("product_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "orders_customer_id_created_at_idx" ON "orders"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_idempotency_key_key" ON "payment_attempts"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_order_id_key" ON "subscriptions"("order_id");

-- CreateIndex
CREATE INDEX "subscriptions_expires_at_status_idx" ON "subscriptions"("expires_at", "status");

-- CreateIndex
CREATE INDEX "conversation_sessions_customer_id_updated_at_idx" ON "conversation_sessions"("customer_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_whatsapp_message_id_key" ON "messages"("whatsapp_message_id");

-- CreateIndex
CREATE INDEX "messages_session_id_created_at_idx" ON "messages"("session_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_ticket_number_key" ON "support_tickets"("ticket_number");

-- CreateIndex
CREATE INDEX "support_tickets_status_priority_idx" ON "support_tickets"("status", "priority");

-- CreateIndex
CREATE INDEX "ticket_messages_ticket_id_created_at_idx" ON "ticket_messages"("ticket_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_base_documents_slug_key" ON "knowledge_base_documents"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_base_chunks_document_id_chunk_index_key" ON "knowledge_base_chunks"("document_id", "chunk_index");

-- CreateIndex
CREATE INDEX "notifications_status_created_at_idx" ON "notifications"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_name_language_key" ON "message_templates"("name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_event_id_key" ON "webhook_events"("event_id");

-- CreateIndex
CREATE INDEX "webhook_events_source_created_at_idx" ON "webhook_events"("source", "created_at");

-- CreateIndex
CREATE INDEX "fulfillment_tasks_status_created_at_idx" ON "fulfillment_tasks"("status", "created_at");

-- CreateIndex
CREATE INDEX "pending_approvals_status_action_type_idx" ON "pending_approvals"("status", "action_type");

-- CreateIndex
CREATE UNIQUE INDEX "business_hours_day_of_week_key" ON "business_hours"("day_of_week");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_sessions" ADD CONSTRAINT "conversation_sessions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "conversation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_documents" ADD CONSTRAINT "knowledge_base_documents_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_chunks" ADD CONSTRAINT "knowledge_base_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_base_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_tasks" ADD CONSTRAINT "fulfillment_tasks_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_tasks" ADD CONSTRAINT "fulfillment_tasks_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Append-only enforcement: audit_logs and webhook_events cannot be updated or deleted.
-- (Application code must also treat these as insert-only.)
CREATE RULE audit_logs_no_update AS ON UPDATE TO "audit_logs" DO INSTEAD NOTHING;
CREATE RULE audit_logs_no_delete AS ON DELETE TO "audit_logs" DO INSTEAD NOTHING;
CREATE RULE webhook_events_no_update AS ON UPDATE TO "webhook_events" DO INSTEAD NOTHING;
CREATE RULE webhook_events_no_delete AS ON DELETE TO "webhook_events" DO INSTEAD NOTHING;
