# Example web stack (made up for tests).
terraform {
  required_providers {
    aws    = { source = "hashicorp/aws" }
    random = { source = "hashicorp/random" }
  }
}

/* A commented-out block must not count:
resource "aws_instance" "ghost" {
  ami = "x"
}
*/

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = { Name = "main" } // trailing comment with a brace }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  map_public_ip_on_launch = true
}

resource "aws_security_group" "web" {
  name   = "web-sg"
  vpc_id = aws_vpc.main.id
  description = "braces in a string: { not a block }"
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "web" {
  count                  = 2
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.web.id]
  user_data = <<-EOT
    #!/bin/bash
    echo '{"bucket": "${aws_s3_bucket.assets.bucket}"}' > /etc/app.json
    if [ -f /x ]; then echo "}"; fi
  EOT
  tags = {
    Name = "web-${count.index}"
    Db   = module.db.endpoint
  }
}

resource "aws_s3_bucket" "assets" {
  bucket = "example-assets"
  acl    = "public-read"
}

resource "random_password" "db" {
  length = 24
}

module "db" {
  source    = "./modules/db"
  subnet_id = aws_subnet.public.id
  password  = random_password.db.result
}

module "remote_vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
}

output "web_ip" {
  value = aws_instance.web[0].public_ip
}
