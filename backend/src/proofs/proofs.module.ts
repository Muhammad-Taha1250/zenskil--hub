import { Module } from '@nestjs/common';
import { ProofStorageService } from './proof-storage.service';

@Module({
  providers: [ProofStorageService],
  exports: [ProofStorageService],
})
export class ProofsModule {}
