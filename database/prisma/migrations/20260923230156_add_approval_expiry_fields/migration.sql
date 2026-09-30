-- AlterEnum
ALTER TYPE "ApprovalStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "pending_approvals" ADD COLUMN     "decision_note" TEXT,
ADD COLUMN     "expires_at" TIMESTAMPTZ(6);
