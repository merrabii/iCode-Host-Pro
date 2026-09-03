import { PartialType } from '@nestjs/swagger';
import { CreateKnowledgeArticleDto } from './create-knowledge-article.dto';

/** PATCH semantics — every field optional; undefined = unchanged. */
export class UpdateKnowledgeArticleDto extends PartialType(
  CreateKnowledgeArticleDto,
) {}
