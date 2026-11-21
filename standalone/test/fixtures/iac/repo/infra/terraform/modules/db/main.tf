variable "subnet_id" {}
variable "password" {
  sensitive = true
}

resource "aws_db_subnet_group" "this" {
  name       = "db"
  subnet_ids = [var.subnet_id]
}

resource "aws_db_instance" "this" {
  engine                 = "postgres"
  instance_class         = "db.t3.micro"
  db_subnet_group_name   = aws_db_subnet_group.this.name
  password               = var.password
  publicly_accessible    = true
  storage_encrypted      = false
  multi_az               = false
}

output "endpoint" {
  value = aws_db_instance.this.endpoint
}
